import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { AUTH_REASONS } from './auth-state.mjs';
import { DIAGNOSTIC_CODES } from './telemetry-codes.mjs';
import { recordIssue as _recordIssue } from './telemetry.mjs';
import { CORRELATION_CONSENT_VERSION } from './telemetry-consent.mjs';
import { ensureInstallationId, markBound, needsBinding, rotateInstallationId } from './installation-id.mjs';

// The one authenticated half of the diagnostics path: associates this machine's random
// installation ID with the caller's account. Only ever called with a token that authenticated
// activity already obtained — it never asks for one, and never refreshes.
//
// Nothing here is retried in-band: a failure leaves boundAt null, so the next authenticated
// activity tries again, and until then events stay anonymous.
//
// The diagnostics events carry no explicit source: binding runs on whichever authenticated hook
// called it, and recordIssue inherits that. Stamping diagnostics_worker here said the binding
// happened somewhere it never does.
export async function bindInstallationIfNeeded(token, deps = {}) {
  const postJsonImpl = deps.postJsonImpl == null ? postJson : deps.postJsonImpl;
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  const now = (deps.now == null ? () => Date.now() : deps.now)();
  if (!token || !needsBinding(now)) return { status: 'skipped' };

  const installationId = ensureInstallationId(now);
  if (installationId == null) return { status: 'skipped' };

  let status;
  try {
    // Exactly the two keys the route accepts; user and tenant come from the verified principal
    // and any extra key is a 400.
    const res = await postJsonImpl(
      `${apiBase()}${ENDPOINTS.pluginDiagnosticsInstallation}`,
      token,
      { installationId, consentVersion: CORRELATION_CONSENT_VERSION },
      { timeoutMs: deps.timeoutMs },
    );
    status = res == null ? 0 : res.status;
  } catch {
    recordIssue({
      code: DIAGNOSTIC_CODES.INSTALLATION_BINDING_FAILED,
      reason: AUTH_REASONS.PROBE_UNREACHABLE,
    });
    return { status: 'failed' };
  }

  if (status >= 200 && status < 300) {
    markBound(now);
    return { status: 'bound' };
  }

  if (status === 409) {
    // A binding is never reassigned, so the ID belongs to someone else now. Discard it and let
    // the next authenticated activity mint and bind a fresh one.
    rotateInstallationId();
    recordIssue({
      code: DIAGNOSTIC_CODES.INSTALLATION_BINDING_FAILED,
      reason: AUTH_REASONS.BINDING_CONFLICT,
      httpStatus: 409,
    });
    return { status: 'conflict' };
  }

  recordIssue({
    code: DIAGNOSTIC_CODES.INSTALLATION_BINDING_FAILED,
    httpStatus: status,
  });
  return { status: 'failed' };
}

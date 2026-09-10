import { readJson, writeJsonSecure } from './fs-store.mjs';
import { telemetryConsentFile } from './paths.mjs';

const CONSENT_VERSION = 1;

// What the plugin claims when it binds an installation ID to an account. The RECORD shape stays
// at version 1 so every grant made before correlation existed keeps reading as a grant; this is
// the separate consent the binding route is told about.
export const CORRELATION_CONSENT_VERSION = 2;

export function readConsent() {
  const raw = readJson(telemetryConsentFile());
  if (!raw || raw.version !== CONSENT_VERSION) return null;
  return raw;
}

// Absent record, unreadable record, or anything other than an explicit grant reads as "no".
export function isTelemetryGranted() {
  const state = readConsent();
  return state != null && state.consent === 'granted';
}

export function hasBeenAsked() {
  const state = readConsent();
  return state != null && state.askedAt != null;
}

// A second, independent gate. Correlation is meaningless without diagnostics, so it reads as "no"
// whenever basic diagnostics are off — an old grant is never silently upgraded.
export function isCorrelationGranted() {
  const state = readConsent();
  return state != null && state.consent === 'granted' && state.correlation === 'granted';
}

export function hasCorrelationBeenAsked() {
  const state = readConsent();
  return state != null && state.correlationAskedAt != null;
}

function write(patch) {
  const state = readConsent();
  writeJsonSecure(telemetryConsentFile(), { version: CONSENT_VERSION, ...(state == null ? {} : state), ...patch });
}

export function grantConsent() {
  write({ consent: 'granted', askedAt: new Date().toISOString(), decidedAt: new Date().toISOString() });
}

// Complete opt-out: correlation goes with it, so re-enabling diagnostics never resurrects a
// correlation grant the user has not re-given.
export function denyConsent() {
  write({
    consent: 'denied',
    correlation: 'denied',
    askedAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
  });
}

export function grantCorrelation() {
  write({
    consent: 'granted',
    correlation: 'granted',
    askedAt: new Date().toISOString(),
    correlationAskedAt: new Date().toISOString(),
    correlationDecidedAt: new Date().toISOString(),
  });
}

// Keeps basic diagnostics exactly as they were; only the account link is withdrawn.
export function denyCorrelation() {
  write({
    correlation: 'denied',
    correlationAskedAt: new Date().toISOString(),
    correlationDecidedAt: new Date().toISOString(),
  });
}

// Stamped when the one-time prompt is shown, so it is shown exactly once whatever the answer.
export function markAsked() {
  write({ askedAt: new Date().toISOString() });
}

export function markCorrelationAsked() {
  write({ correlationAskedAt: new Date().toISOString() });
}

// Offered once to a machine that already sends anonymous diagnostics. Declining changes nothing:
// anonymous reporting continues either way, so the offer never blocks it.
export function correlationPrompt() {
  if (!isTelemetryGranted()) return null;
  if (hasCorrelationBeenAsked()) return null;
  markCorrelationAsked();
  return 'Beezi diagnostics are on. Optionally, a random installation ID can associate a failure '
    + 'with the last Beezi account linked on this machine, so support can find your report. It is '
    + 'off unless you turn it on: run /beezi:telemetry correlate to allow it, or ignore this — '
    + 'anonymous reporting continues either way.';
}

// Prints what the startup card shows, as one line of JSON, for hooks/card.jsx. Local reads only.
import { listAccounts, getDefaultKey, AccountStatus } from '../lib/accounts.mjs';
import { tenantsOf, isMultiTenant, currentSessionWorkspace, roleLabel } from '../lib/workspace.mjs';
import { createRouteContext } from '../lib/workspace-rules.mjs';
import { placeOfDir, routeOfDir, routeOfSession, routeTarget, routeReason } from '../lib/route-describe.mjs';
import { accountLabel, liveOffNote } from '../lib/session-banner.mjs';
import { readTrackingState } from '../lib/tracking.mjs';
import { anonymizationFor, kindsOf } from '../lib/anonymization.mjs';
import { isEntryScript } from '../lib/entry-script.mjs';
import { listProgress, isLive, progressPath, markReported } from '../lib/upload-progress.mjs';
import { barLine, doneLine } from '../lib/upload-progress-view.mjs';
import { oneLine } from '../lib/one-line.mjs';
import { SAFE_TENANT_ID } from '../lib/whoami.mjs';

const ACCOUNT_KEY = /^[0-9a-f]{8}$/;

// Live uploads, and finished ones nobody has shown yet. A run that did not end clean is not listed.
function uploadFact(record, nowMs) {
  const finished = record.finishedAt != null;
  if (finished && record.failed === true) return null;
  if (!isLive(record, nowMs) && (!finished || record.reported)) return null;
  const { key, tenantId, workspace, processed, total, sent } = record;
  const line = finished ? doneLine(record) : barLine(record);
  return { key, tenantId, workspace, processed, total, sent, finished, path: progressPath(key, tenantId), line };
}

export function cardFacts({ rows, def, state, dir, ctx, readTracking = readTrackingState, list = listProgress, now = Date.now }) {
  const place = placeOfDir(dir, ctx);
  const linked = rows.filter((row) => row.status == null || row.status === AccountStatus.LINKED);
  const accounts = linked
    .map((row) => {
      const route = state != null ? routeOfSession(row, state, place) : routeOfDir(row, dir, ctx);
      const reason = route.reason;
      return {
        key: row.key,
        label: accountLabel(row),
        isDefault: row.key === def,
        isMulti: isMultiTenant(row),
        workspaces: (tenantsOf(row) || []).map((t) => ({ id: t.id, name: t.name || t.id, role: roleLabel(t) })),
        route: {
          kind: reason.kind,
          ids: route.ids,
          target: routeTarget(row, route),
          reason: routeReason(route),
          ruleIndex: reason.kind === 'rule' && reason.index != null ? reason.index : null,
          isOwnRule: reason.kind === 'rule' && reason.own === true,
        },
        note: liveOffNote(row, readTracking(row.key), route),
        anonymized: route.ids.some((id) => kindsOf(anonymizationFor(row, id)).length > 0),
      };
    });
  const nowMs = now();
  const uploads = linked
    .flatMap((row) => list(row.key))
    .map((record) => uploadFact(record, nowMs))
    .filter((upload) => upload != null);
  return { place: place == null ? null : { short: oneLine(place.short), kind: place.kind, path: oneLine(place.path), remote: oneLine(place.remote) }, accounts, uploads };
}

async function main() {
  if (process.argv[2] === '--reported') {
    const [key, tenantId] = process.argv.slice(3);
    if (ACCOUNT_KEY.test(key ?? '') && SAFE_TENANT_ID.test(tenantId ?? '')) markReported(key, tenantId);
    return;
  }
  const state = currentSessionWorkspace(process.cwd());
  const dir = state != null && state.cwd != null ? state.cwd : process.cwd();
  const rows = await listAccounts();
  process.stdout.write(JSON.stringify(cardFacts({ rows, def: await getDefaultKey(), state, dir, ctx: createRouteContext() })));
}

if (isEntryScript(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(String(error && error.message ? error.message : error));
    process.exit(1);
  });
}

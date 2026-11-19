import { planWorkspaceRuns, createRunCache } from '../lib/session-audit.mjs';
import { parseAccountFlag, getAccount, describeAccount } from '../lib/accounts.mjs';
import { isMultiTenant } from '../lib/workspace.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { startHistoryWorker } from '../lib/history-trigger.mjs';
import { OfferVia, offerTenantKey } from '../lib/history-offer.mjs';
import { answeredSetupListing, openTenantIds, removeSetupListing, retryWhileBusy } from '../lib/setup-places.mjs';
import { isEntryScript } from '../lib/entry-script.mjs';
import {
  countWorkspace, presentOffers, oweConsented, acceptOffer, acceptPrefix, foregroundRun, printCounts, flagValue, routeSummary, workspaceName,
} from '../lib/history-summary.mjs';

// The login flow's history step (/beezi:login and the setup wizard). Without --accept it counts each workspace's past
// sessions with a dry run and prints them: an ask-first workspace's question uploads nothing until a yes, and a workspace
// whose owner chose upload without asking prints a notice and uploads now. `--accept <tenant> --offer <token>` uploads
// exactly the sessions that workspace's printed offer counted.

const WORKER_LATER = 'Beezi: the past-session upload will start with your next Claude Code session.';

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// One dry run per workspace whose offer gate is open; { counted, status }, status 1 when any workspace failed.
async function countOpen(row, deps) {
  let tenantIds = openTenantIds(row);
  let planRuns;
  const multi = isMultiTenant(row);
  if (multi && tenantIds.length > 0) {
    const plan = (deps.planWorkspaceRuns == null ? planWorkspaceRuns : deps.planWorkspaceRuns)(row);
    if (plan.scanned === 0) {
      console.log('✓ Beezi: no past Claude Code sessions found to upload.');
      tenantIds = [];
    } else {
      const summary = routeSummary(row, plan);
      if (summary != null) console.log(summary);
      tenantIds = plan.tenantIds.filter((id) => tenantIds.indexOf(id) !== -1);
      planRuns = () => plan;
    }
  }
  // One git cache for every workspace's run, so each session's git correlation runs once.
  const ctx = { via: OfferVia.LOGIN, override: false, planRuns, runCache: createRunCache() };
  const counted = [];
  let status = 0;
  for (const tenantId of tenantIds) {
    if (multi) console.log(`\n— ${describeAccount(row)} · ${workspaceName(row, tenantId)} —`);
    // One workspace's exception must not stop the rest.
    try {
      const done = await countWorkspace(row, tenantId, ctx, deps);
      if (done.offer != null) counted.push({ tenantId, ...done });
      if (done.status !== 0) status = 1;
    } catch (error) {
      console.error(`✗ ${friendlyMessage(error)}`);
      status = 1;
    }
  }
  return { counted, status };
}

// The counted workspaces' offers, then `offers=<n> notices=<m>`; the exit status is 1 when any workspace failed.
export async function backfillSummary(row, deps = {}) {
  const { counted, status: countStatus } = await countOpen(row, deps);
  let status = countStatus;
  let shown = { offers: 0, notices: 0 };
  try {
    shown = await presentOffers(row, counted, { uploadPrefix: acceptPrefix('backfill.mjs', row), background: false, runOne: foregroundRun(deps) });
    if (shown.status !== 0) status = 1;
  } catch (error) {
    console.error(`✗ ${friendlyMessage(error)}`);
    status = 1;
  }
  printCounts(shown);
  return status;
}

// The consented run's last line, with the distinct sessions owed and the owed workspaces' progress-record keys; returns `status`.
function printUploading(row, owed, status) {
  const ids = new Set();
  owed.forEach((c) => c.offer.sessionIds.forEach((id) => ids.add(id)));
  const tenants = owed.map((c) => offerTenantKey(row, c.tenantId)).join(',');
  console.log(`uploading=${ids.size} workspaces=${owed.length} tenants=${tenants}`);
  return status;
}

// Each counted workspace's sessions that the answered listing showed; a workspace left with none is dropped.
function onlyListed(counted, sessionIds) {
  const listed = new Set(sessionIds);
  return counted
    .map((c) => ({ ...c, offer: { ...c.offer, sessionIds: c.offer.sessionIds.filter((id) => listed.has(id)) } }))
    .filter((c) => c.offer.sessionIds.length > 0);
}

async function oweListed(row, listing, deps) {
  const done = await countOpen(row, deps);
  if (done.status !== 0) return printUploading(row, [], 1);
  const { owed, status } = await oweConsented(row, onlyListed(done.counted, listing.sessionIds));
  if (owed.length === 0) return printUploading(row, [], status);
  const start = deps.startHistoryWorker == null ? startHistoryWorker : deps.startHistoryWorker;
  if (!(await start(row.key))) {
    console.log(WORKER_LATER);
    return printUploading(row, [], 1);
  }
  return printUploading(row, owed, status);
}

// Owes each workspace the answered listing's sessions it routes to now and starts the worker once, then drops the listing; the exit status.
export async function backfillConsented(row, deps = {}) {
  const listing = answeredSetupListing(row.key);
  if (listing == null) return printUploading(row, [], 0);
  const runAudit = retryWhileBusy(deps.runAudit, deps);
  try {
    return await oweListed(row, listing, { ...deps, runAudit });
  } finally {
    removeSetupListing(row.key);
  }
}

// Uploads the sessions the workspace's offer counted, when `token` names that offer; its exit status.
export function backfillAccept(row, tenantKey, token, deps = {}) {
  return acceptOffer(row, tenantKey, token, foregroundRun(deps));
}

async function main() {
  const { account, rest } = await parseAccountFlag(process.argv.slice(2));
  if (account == null) fail('Beezi: backfill needs --account <key|email|n>. /beezi:login passes it automatically.');
  const row = (await getAccount(account)) || { key: account };
  if (rest.indexOf('--consented') !== -1) {
    if (await backfillConsented(row) !== 0) process.exit(1);
    return;
  }
  const tenantKey = flagValue(rest, '--accept');
  if (tenantKey == null) {
    if (await backfillSummary(row) !== 0) process.exit(1);
    return;
  }
  const status = await backfillAccept(row, tenantKey, flagValue(rest, '--offer'));
  await startHistoryWorker(account);
  if (status !== 0) process.exit(1);
}

if (isEntryScript(import.meta.url)) main().catch((error) => fail(friendlyMessage(error)));

import { parseAccountFlag, getAccount, clearOfferReady, recordOfferDecline } from '../lib/accounts.mjs';
import { declineLine, readOffer, removeOffer, idsToken, workspaceWhoami, plural } from '../lib/history-offer.mjs';
import {
  CHANGED_LINE, scriptCommand, flagValue, tenantIdOfKey, nothingLine, matchesShown, oweUpload, backgroundLine, presentOffers, printCounts, freshMode,
  offerChangedAt, workspaceName, followRecord,
} from '../lib/history-summary.mjs';
import { offerStateOf, OfferMode } from '../lib/offer-gate.mjs';
import { rememberDeclined, forgetDeclined } from '../lib/offer-declines.mjs';
import { startHistoryWorker, workspacesAt } from '../lib/history-trigger.mjs';
import { readTrackingState } from '../lib/tracking.mjs';
import { isEntryScript } from '../lib/entry-script.mjs';
import { friendlyMessage, UserError } from '../lib/friendly-error.mjs';

// The history offer's commands: `offer` prints the session-start question or notice, `accept` queues the upload, `decline` remembers a no.

const USAGE = 'Usage: history.mjs offer --account <key> | accept --account <key> --tenant <key> --offer <token> | decline --account <key> --tenant <key> [--audit] [--offer <token>]';

const sessionIdsOf = (file) => (file != null && Array.isArray(file.sessionIds) ? file.sessionIds : []);

// The offer file the scan's ready token was counted from, else null (missing, empty or rewritten since, M1).
function readyOffer(row, tenantId, tenantKey) {
  const stored = readOffer(row.key, tenantKey);
  const ids = sessionIdsOf(stored);
  return ids.length > 0 && idsToken(ids) === offerStateOf(row, tenantId).ready.token ? stored : null;
}

// The session-start offers of every workspace whose scan is ready, built from the file the scan counted; a ready
// workspace without that file loses ready and scans again. A printed question records the decline (K6); a no-ask
// workspace's upload is owed to the history worker only when its fresh whoami still says upload (R17), Audit workspaces
// included. The exit status: 1 when a workspace failed.
export async function offer(row, deps = {}) {
  let shown = { offers: 0, notices: 0, status: 0 };
  if (row != null) {
    const counted = [];
    for (const { tenantId, tenantKey, mode } of await workspacesAt(row, readTrackingState(row.key), 'READY')) {
      const stored = readyOffer(row, tenantId, tenantKey);
      if (stored == null) {
        await clearOfferReady(row.key, tenantKey);
        continue;
      }
      const noAsk = mode === OfferMode.UPLOAD;
      const who = noAsk ? await workspaceWhoami(row, tenantId, deps) : null;
      counted.push({ tenantId, offer: stored, who, mode: noAsk ? freshMode(who, tenantId) : OfferMode.ASK });
    }
    const uploadPrefix = (tenantKey) => `${scriptCommand('history.mjs')} accept --account ${row.key} --tenant ${tenantKey}`;
    shown = await presentOffers(row, counted, { uploadPrefix, background: true });
    if (shown.notices > 0) await startHistoryWorker(row.key);
  }
  printCounts(shown);
  return shown.status;
}

// The upload the worker now runs, shown through its progress record: the card line when the card draws it, else
// plain lines and a last line that closes the follow (followRecord's). `since` and `count` = when the yes came and how many sessions it covers.
export async function followAccepted(row, tenantKey, { since, count }, deps = {}) {
  const { env = process.env, log = console.log } = deps;
  if (env.BEEZI_CARD && env.BEEZI_CARD === env.CLAUDE_CODE_SESSION_ID) {
    log(`✓ Uploading ${plural(count, 'past session')} to ${workspaceName(row, tenantIdOfKey(tenantKey))} — progress is on the Beezi card`);
    return;
  }
  await followRecord(row, tenantKey, since, { ...deps, log });
}

// The session-start yes: owes the workspace the shown offer's sessions, starts the worker and follows its progress.
async function accept(row, tenantKey, token) {
  const tenantId = tenantIdOfKey(tenantKey);
  const stored = row == null ? null : readOffer(row.key, tenantKey);
  if (stored != null && !matchesShown(stored, token)) {
    console.log(CHANGED_LINE);
    return;
  }
  if (stored != null) forgetDeclined(row.key, tenantKey, stored.sessionIds);
  if (stored == null || !(await oweUpload(row, tenantId, stored))) {
    console.log(nothingLine(row == null ? {} : row, tenantId));
    return;
  }
  const since = Date.now();
  if (await startHistoryWorker(row.key)) await followAccepted(row, tenantKey, { since, count: stored.sessionIds.length });
  else console.log(backgroundLine(row, [tenantId], stored.sessionIds.length));
}

// The session-start no: remembers the offer's sessions as declined, then the workspace's decline. The file goes only
// while it still holds the sessions declined; one rewritten in between is another question.
async function decline(row, tenantKey, audit, token) {
  const stored = row == null ? null : readOffer(row.key, tenantKey);
  const stale = token != null && stored != null && !matchesShown(stored, token);
  if (row != null && !stale) {
    const changedAt = offerChangedAt(row, tenantIdOfKey(tenantKey), stored);
    const ids = sessionIdsOf(stored);
    if (ids.length > 0) rememberDeclined(row.key, tenantKey, ids, changedAt);
    await recordOfferDecline(row.key, tenantKey, changedAt);
    if (idsToken(sessionIdsOf(readOffer(row.key, tenantKey))) === idsToken(ids)) removeOffer(row.key, tenantKey);
  }
  console.log(declineLine(audit));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { account, rest } = await parseAccountFlag(args);
  if (account == null) throw new UserError(USAGE);
  const row = await getAccount(account);
  if (cmd === 'offer') {
    if ((await offer(row)) !== 0) process.exitCode = 1;
    return;
  }
  const tenantKey = flagValue(rest, '--tenant');
  if (tenantKey == null) throw new UserError(USAGE);
  if (cmd === 'accept') return accept(row, tenantKey, flagValue(rest, '--offer'));
  if (cmd === 'decline') return decline(row, tenantKey, rest.indexOf('--audit') !== -1, flagValue(rest, '--offer'));
  throw new UserError(USAGE);
}

if (isEntryScript(import.meta.url)) {
  main().catch((error) => {
    console.error(`✗ ${friendlyMessage(error)}`);
    process.exit(1);
  });
}

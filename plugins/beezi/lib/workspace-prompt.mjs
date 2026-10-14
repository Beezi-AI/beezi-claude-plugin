import path from 'path';
import { fileURLToPath } from 'url';
import {
  isMultiTenant,
  newTenantsOf,
  readSessionWorkspace,
  resolveTargets,
  roleLabel,
  tenantById,
} from './workspace.mjs';
import { bindSessionRoutes, createRouteContext, routeKeyForDir, shortLabel, usesRules } from './workspace-rules.mjs';
import { resultLine } from './pending-history.mjs';

const GROUP_SIZE = 4;
// Only a new session or /clear asks; resume and compact never do.
const ASK_SOURCES = ['startup', 'clear'];

export function pluginRoot(deps = {}) {
  const env = deps.env == null ? process.env : deps.env;
  const root = deps.pluginRoot != null
    ? deps.pluginRoot
    : (env.CLAUDE_PLUGIN_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  return root.replace(/\\/g, '/');
}

async function linkedRows(deps) {
  const accounts = await import('./accounts.mjs');
  const listAccounts = deps.listAccounts == null ? accounts.listAccounts : deps.listAccounts;
  const rows = await listAccounts(deps);
  return rows.filter((a) => a.status === accounts.AccountStatus.LINKED);
}

// Only rows with a usable login (runSessionStart's "linked" test): one whose credentials are gone is neither asked nor told.
async function withUsableLogin(rows, deps) {
  const sessionFor = deps.sessionFor == null ? (await import('./sessions.mjs')).sessionFor : deps.sessionFor;
  const live = await Promise.all(rows.map((row) => sessionFor(row.key, deps).catch(() => null)));
  return rows.filter((row, i) => live[i] != null);
}

function inputCwd(input) {
  return typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
}

// A multi-workspace row's tenantName is the web-side workspace, so accounts are named by email.
function emailOf(row) {
  return row.email || row.key;
}

function nameOf(row, id) {
  const t = tenantById(row, id);
  return t != null && t.name ? t.name : id;
}

// "A", "A and B", "A, B and C".
function names(row, ids) {
  const list = ids.map((id) => nameOf(row, id));
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// How the targets notice names a place: a folder's ~ path, a repo's name, or sessions outside a project.
function noticePlace(key) {
  if (key == null) return 'this folder';
  if (key.kind === 'outside') return 'sessions outside a project';
  if (key.kind === 'folder' && key.label) return key.label;
  return shortLabel(key) || 'this folder';
}

// Splits n items into ceil(n/4) groups whose sizes differ by at most one (5 → 3+2).
function chunkEvenly(items) {
  const count = Math.ceil(items.length / GROUP_SIZE);
  const groups = [];
  let start = 0;
  for (let i = 0; i < count; i += 1) {
    const size = Math.ceil((items.length - start) / (count - i));
    groups.push(items.slice(start, start + size));
    start += size;
  }
  return groups;
}

// The question wording for this directory: a repo, a folder, or the one "outside a project" place.
function placeOf(key) {
  if (key != null && key.kind === 'outside') {
    return {
      question: 'Where should analytics for sessions outside a project folder go?',
      dontTrack: 'Don\'t track these',
      nothing: 'Nothing from sessions outside a project folder is uploaded',
    };
  }
  const short = shortLabel(key);
  // A folder rule covers everything under it, so its question names the whole path and says so.
  const asked = key != null && key.kind === 'folder' ? `${key.label} (and everything inside it)` : short;
  return {
    question: `Where should analytics for ${asked} go?`,
    dontTrack: key != null && key.kind === 'repo' ? 'Don\'t track this repo' : 'Don\'t track this folder',
    nothing: `Nothing from ${short} is uploaded`,
  };
}

function optionText(o) {
  return o.description ? `"${o.label}" (description "${o.description}")` : `"${o.label}"`;
}

function optionList(options) {
  const texts = options.map(optionText);
  return texts.length === 1 ? texts[0] : `${texts.slice(0, -1).join(', ')}, and ${texts[texts.length - 1]}`;
}

function span(numbers) {
  return numbers.length === 1 ? `question ${numbers[0]}` : `questions ${numbers[0]}–${numbers[numbers.length - 1]}`;
}

// One account's questions (split evenly past 4 options) and the command its answer runs.
function accountAsk(row, resolved, place, { sessionId, root, several }) {
  const tenants = resolved.tenants.filter((t) => resolved.askTenants.indexOf(t.id) !== -1);
  const label = (t) => (t.name ? t.name : t.id);
  const options = tenants.map((t) => ({ label: label(t), description: roleLabel(t) }))
    .concat([{ label: place.dontTrack, description: place.nothing }]);
  const groups = chunkEvenly(options);
  const questions = groups.map((group, i) => {
    const tags = [several ? emailOf(row) : null, groups.length > 1 ? `${i + 1} of ${groups.length}` : null].filter(Boolean);
    return { text: tags.length > 0 ? `${place.question} (${tags.join(', ')})` : place.question, options: group };
  });
  return {
    row,
    questions,
    command: `node "${root}/scripts/workspace.mjs" rule add --current --session ${sessionId} --account ${row.key} <ids>`,
    ids: tenants.map((t) => `${label(t)} = ${t.id}`).join(', '),
    dontTrack: place.dontTrack,
  };
}

function promptText(asks) {
  const all = [];
  for (const ask of asks) {
    ask.numbers = ask.questions.map((q) => { all.push(q); return all.length; });
  }
  let asking;
  if (all.length === 1) {
    asking = `use the AskUserQuestion tool (multiSelect: true) to ask: "${all[0].text}" with the options ${optionList(all[0].options)}.`;
  } else {
    const listed = all.map((q, i) => `question ${i + 1} "${q.text}" with the options ${optionList(q.options)}`).join('; ');
    const calls = chunkEvenly(all.map((q, i) => i + 1));
    asking = calls.length === 1
      ? `use the AskUserQuestion tool to ask ${all.length} questions in one call, each with multiSelect: true: ${listed}.`
      : `use the AskUserQuestion tool with multiSelect: true on every question: ${listed}. Make one AskUserQuestion call per message, waiting for each answer before the next: ${calls.map((c, i) => `call ${i + 1} asks ${span(c)}`).join(', ')}.`;
  }
  const several = asks.length > 1;
  const runs = asks.map((ask, i) => {
    const idsOf = ask.questions.length > 1 || several
      ? `the ids of the workspaces chosen in ${span(ask.numbers)} joined by commas`
      : 'the chosen workspaces\' ids joined by commas';
    const lead = several ? `${i === 0 ? 'Then, for' : 'For'} ${emailOf(ask.row)} (${span(ask.numbers)}), run exactly` : 'Then run exactly';
    return `${lead} \`${ask.command}\`. \`<ids>\` is ${idsOf} (${ask.ids}), or \`none\` when "${ask.dontTrack}" is chosen; it wins over the others.`;
  });
  const tail = several
    ? 'Show the user only the first line of each command\'s output. If a question is dismissed or nothing is chosen for an account, run nothing for it and continue with the user\'s request.'
    : 'Show the user only the command\'s first line. If the question is dismissed or nothing is chosen, run nothing and continue with the user\'s request.';
  return [`Before doing anything else, ${asking}`, ...runs, tail].join(' ');
}

// Binds each multi-workspace account's rule for this directory (null unbinds); the pending rows, or null when none.
export async function markPendingWorkspace(input, deps = {}) {
  if (input == null || typeof input.session_id !== 'string' || input.session_id === '') return null;
  const sessionId = input.session_id;
  const cwd = inputCwd(input);
  const rows = await linkedRows(deps);
  const bound = rows.filter(usesRules);
  if (bound.length === 0) return null;
  const ctx = createRouteContext();
  // Re-matched on every start, resume and compact: a rule added since binds, a removed one unbinds.
  // Written even when nothing is pending: it keeps this the newest session in its directory for the cwd fallback.
  const state = bindSessionRoutes(sessionId, cwd, bound, ctx);
  if (state == null) return null;
  const multi = rows.filter(isMultiTenant);
  const pending = multi
    .map((row) => ({ row, resolved: resolveTargets(row, state) }))
    .filter((r) => r.resolved.pendingAsk);
  return pending.length === 0 ? null : { pending, cwd, ctx, several: rows.length > 1 };
}

// SessionStart: re-binds on every source; the ask text on startup, clear or no source, or null when nothing is pending.
export async function buildWorkspacePrompt(input, deps = {}) {
  if (input == null || typeof input.session_id !== 'string' || input.session_id === '') return null;
  const marked = await markPendingWorkspace(input, deps);
  if (marked == null) return null;
  if (input.source != null && ASK_SOURCES.indexOf(input.source) === -1) return null;
  const usable = await withUsableLogin(marked.pending.map((p) => p.row), deps);
  const pending = marked.pending.filter((p) => usable.indexOf(p.row) !== -1);
  if (pending.length === 0) return null;
  const place = placeOf(routeKeyForDir(marked.cwd, marked.ctx));
  const root = pluginRoot(deps);
  const asks = pending.map(({ row, resolved }) => accountAsk(row, resolved, place, {
    sessionId: input.session_id, root, several: marked.several,
  }));
  return promptText(asks);
}

// SessionStart: one line per multi-workspace account that is not waiting for an answer, or null.
export async function buildTargetsNotice(input, deps = {}) {
  if (input == null || typeof input.session_id !== 'string' || input.session_id === '') return null;
  const rows = await linkedRows(deps);
  const state = readSessionWorkspace(input.session_id);
  // A no-rules one-workspace row can never produce a line here (resolveTargets gives 'single'), so
  // skip its credential read.
  const shown = await withUsableLogin(rows.filter((row) => isMultiTenant(row) || usesRules(row)), deps);
  const ctx = createRouteContext();
  let here;
  const hereKey = () => {
    if (here === undefined) here = routeKeyForDir(state != null && state.cwd != null ? state.cwd : inputCwd(input), ctx);
    return here;
  };
  const lines = shown
    .map((row) => ({ row, resolved: resolveTargets(row, state) }))
    .filter((r) => (r.resolved.multi && !r.resolved.pendingAsk) || (r.resolved.source === 'rule' && r.resolved.targets.length === 0))
    .map(({ row, resolved }) => {
      const prefix = rows.length > 1 ? `Beezi (${emailOf(row)})` : 'Beezi';
      const key = resolved.rule != null ? resolved.rule : hereKey();
      const where = noticePlace(key);
      let text;
      if (resolved.source === 'rule' && resolved.targets.length === 0) {
        text = `${where} ${key != null && key.kind === 'outside' ? 'are' : 'is'} not tracked (your rule).`;
      } else if (resolved.source === 'none') {
        text = `analytics from ${where} are not uploaded (new folders: don't send).`;
      } else {
        const fallback = resolved.source === 'new-folders' ? ' (new folder default)' : '';
        text = `analytics from ${where} go to ${names(row, resolved.targets)}${fallback}.`;
      }
      return `${prefix}: ${text} Change with /beezi:settings.`;
    });
  return lines.length === 0 ? null : lines.join('\n');
}

// The current-folder question (buildWorkspacePrompt) may follow: asked per account only while this folder still has no rule.
function hereGateText(rows, root, sessionId) {
  const commands = rows.map((row) => `\`node "${root}/scripts/workspace.mjs" rules --session ${sessionId} --account ${row.key}\``).join(', then ');
  return [
    `If a separate question about where this session's own folder goes follows, first run EXACTLY ${commands} (its output is for you only).`,
    'For each of these accounts whose `here:` line does not show `rule=none`, leave out that account\'s part of that question and its command: the answer above already set where this folder goes.',
    'Then go on to that question if anything is left of it; otherwise continue with the user\'s request.',
  ];
}

function joinedPromptText(rows, root, sessionId) {
  const who = rows.length === 1 ? `${emailOf(rows[0])} joined ${names(rows[0], newTenantsOf(rows[0]))}` : 'these Beezi accounts joined new workspaces';
  const commands = rows.map((row) => `\`node "${root}/scripts/workspace.mjs" joined --account ${row.key}\``).join(', then ');
  // Without a session id no current-folder question follows (buildWorkspacePrompt needs one).
  const after = sessionId == null ? ['Then continue with the user\'s request.'] : hereGateText(rows, root, sessionId);
  return [
    `Beezi: ${who}.`,
    'Only if the AskUserQuestion tool is available to you in this session, do the following before anything else; otherwise skip it entirely and never mention it.',
    `Run EXACTLY ${commands}.`,
    `Then read "${root}/commands/sync.md" and follow its Step 1 from "Its output is for you only. For an account that joined" up to the paragraph that begins "Then, repos and folders with no rule. Run", for that output only, with three changes:`,
    '(1) always ask the first single-select question ("You joined …") first, even with 4 or fewer J lines, and add a last option "Later" (description "Ask me again in my next session") that runs nothing; on "Choose repos", ask for each new workspace the multi-select "Which repos and folders should also send analytics to <name>?" (worded as in sync.md) with the J lines as options, at most 3 per question and ending in "None of these" as in sync.md ("None of these" picks nothing), and for each picked one run its `joined pick` J-command with that workspace\'s tenant id;',
    '(2) leave out the "Add … to all" option when every J line ends in now=pending or now=none;',
    '(3) stop after that part: run neither routes nor sync.mjs, because the upload starts by itself.',
    ...after,
  ].join(' ');
}

// SessionStart: the joined re-pick, asked on startup or clear until the join is reviewed; null when nothing is new.
export async function buildJoinedPrompt(input, deps = {}) {
  if (input == null) return null;
  if (input.source != null && ASK_SOURCES.indexOf(input.source) === -1) return null;
  const fresh = (await linkedRows(deps)).filter((row) => newTenantsOf(row).length > 0);
  if (fresh.length === 0) return null;
  const rows = await withUsableLogin(fresh, deps);
  const sessionId = typeof input.session_id === 'string' && input.session_id !== '' ? input.session_id : null;
  return rows.length === 0 ? null : joinedPromptText(rows, pluginRoot(deps), sessionId);
}

// SessionStart: one user-only line per finished history upload, shown once on startup or clear.
export async function buildHistoryNotice(input, deps = {}) {
  if (input == null) return null;
  if (input.source != null && ASK_SOURCES.indexOf(input.source) === -1) return null;
  const rows = await linkedRows(deps);
  const waiting = rows.filter((row) => Array.isArray(row.historyResults) && row.historyResults.length > 0);
  if (waiting.length === 0) return null;
  const take = deps.takeHistoryResults == null ? (await import('./accounts.mjs')).takeHistoryResults : deps.takeHistoryResults;
  const lines = [];
  for (const row of waiting) {
    let taken = [];
    try { taken = await take(row.key); } catch { continue; }
    const prefix = rows.length > 1 ? `Beezi (${emailOf(row)})` : 'Beezi';
    for (const result of taken) lines.push(resultLine(result, { prefix, nameOf: (id) => nameOf(row, id), syncName: '/beezi:sync' }));
  }
  return lines.length === 0 ? null : lines.join('\n');
}

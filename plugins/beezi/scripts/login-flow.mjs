import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { getAccount, parseAccountFlag } from '../lib/accounts.mjs';
import { currentSessionWorkspace, isMultiTenant, newFoldersOf, roleLabel, tenantsOf } from '../lib/workspace.mjs';
import { createRouteContext, routeForDir, routeKeyForDir } from '../lib/workspace-rules.mjs';
import { placeOfDir } from '../lib/route-describe.mjs';
import { pastSessions } from '../lib/past-sessions.mjs';
import { paymentQuestion, parseKeyStatus } from '../lib/setup-plan.mjs';
import { lastLine } from '../lib/setup-routing.mjs';
import { UserError, friendlyMessage } from '../lib/friendly-error.mjs';
import { isEntryScript } from '../lib/entry-script.mjs';
import { joined, routes, rules } from './workspace.mjs';

// /beezi:login's commands in as few calls as its questions allow: each call runs from the start (or
// `--from <step>`) up to the next question, printing every output as a block and `next=<step>` last.
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FROM_STEPS = ['here', 'plan', 'joined', 'routes'];
const USAGE = 'Usage: login-flow.mjs [--account <ref> --from <here|plan|joined|routes>]';
// Statuses whose answer is the local capture, so its gateway or tier question may follow (login.md Step 3).
const CAPTURE_STATUSES = ['no_key', 'not_linked'];
// Writes made between calls leave the upload to login.md's backfill.
const DEFER = { deferUpload: true };
// The setup question previews this many workspaces, then Several workspaces… reaches every one.
const PREVIEW_WORKSPACES = 2;

function runScript(script, args) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, script)].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error != null) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Streams as it runs: the sign-in prints its URL while it waits for the browser. Its stderr stays inside the
// block too, since Step 1 relays the ✗ line.
function runLive(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, script)].concat(args), { stdio: ['inherit', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { process.stdout.write(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

function block(tag, result) {
  const text = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
  console.log([`<${tag}>`].concat(text === '' ? [] : [text], [`</${tag.split(' ')[0]}>`]).join('\n'));
}

// What the listing returned, or null when it failed: its ✗ line stays in its block and the later steps still run.
async function listing(tag, key, print) {
  console.log(`<${tag} account="${key}">`);
  let result = null;
  try {
    result = await print();
  } catch (error) {
    console.log(`✗ ${friendlyMessage(error)}`);
    result = null;
  }
  console.log(`</${tag}>`);
  return result;
}

function next(step, key) {
  console.log(key == null ? `next=${step}` : `next=${step} account=${key}`);
}

// This session's directory: its workspace state's cwd, else the process's.
function hereDir() {
  const state = currentSessionWorkspace();
  return state != null && state.cwd != null ? state.cwd : process.cwd();
}

// This session's folder still has no rule under Ask me (login.md Step 1w, "this session's own folder").
function hereNeedsRule(row) {
  if (!isMultiTenant(row) || newFoldersOf(row).mode !== 'ask') return false;
  const dir = hereDir();
  const ctx = createRouteContext();
  return routeKeyForDir(dir, ctx) != null && routeForDir(row, dir, ctx) == null;
}

const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

// Label/value rows with the values in one column, three spaces past the longest label.
function columns(rows) {
  const width = Math.max(...rows.map(([label]) => label.length)) + 3;
  return rows.map(([label, value]) => `${label.padEnd(width)}${value}`);
}

// The setup question's rows: New folders, this place (omitted when unknown) and the other places (omitted at 0).
function previewRows(here, places, values) {
  const rows = [['New repos and folders', values.newFolders]];
  if (here != null) rows.push([here.kind === 'outside' ? 'Sessions outside a project' : `${here.short} (here)`, values.here]);
  const other = here == null ? '' : 'other ';
  if (places > 0) rows.push([plural(places, `${other}repo or folder`, `${other}repos and folders`), values.places]);
  return columns(rows);
}

// `heading`, then every row `→ <target>` and the upload line naming `uploadTo`.
function sendPreview(heading, target, uploadTo, here, counts) {
  const to = `→ ${target}`;
  const lines = [heading, ''].concat(previewRows(here, counts.places, { newFolders: to, here: to, places: to }), ['']);
  if (counts.sessions > 0) lines.push(`Then ${plural(counts.sessions, 'past session uploads', 'past sessions upload')} to ${uploadTo}.`);
  lines.push('Change any of it in /beezi:settings.');
  return lines;
}

const workspacePreview = (name, here, counts) => sendPreview(`Everything goes to ${name}:`, name, name, here, counts);
const severalPreview = (here, counts) => sendPreview('Everything goes to each workspace you pick next:', 'the ones you pick', 'each of them', here, counts);

function choosePreview(here, counts) {
  const lines = ['Pick where each repo goes:', ''].concat(previewRows(here, counts.places, { newFolders: 'ask me', here: 'asked next', places: 'asked next' }));
  if (counts.sessions > 0) lines.push('', counts.sessions === 1 ? 'Then the past session uploads where you chose.' : 'Then past sessions upload where you chose.');
  return lines;
}

function printPreview(tenant, lines) {
  console.log([`<preview tenant="${tenant}">`].concat(lines, ['</preview>']).join('\n'));
}

// login.md Step 1w's one question: the workspaces and counts, then a preview per answer.
// A count that fails shows its ✗ line and previews as 0 sessions and places, like a failed listing: the question still stands.
function setupQuestion(row, { pastSessions: count, herePlace }) {
  const tenants = tenantsOf(row);
  let here = null;
  try { here = herePlace(); } catch { here = null; }
  console.log(`<setup account="${row.key}">`);
  for (const t of tenants) console.log(`W. ${t.name ? t.name : t.id} account=${row.key} tenant=${t.id} role=${roleLabel(t)}`);
  let counts = { sessions: 0, places: 0 };
  try {
    counts = count(row, here == null ? null : here.key);
    console.log(`sessions=${counts.sessions} places=${counts.places}`);
  } catch (error) {
    console.log(`✗ ${friendlyMessage(error)}`);
  }
  console.log('</setup>');
  for (const t of tenants.slice(0, PREVIEW_WORKSPACES)) printPreview(t.id, workspacePreview(t.name ? t.name : t.id, here, counts));
  printPreview('several', severalPreview(here, counts));
  printPreview('choose', choosePreview(here, counts));
}

// Step 2 and 3s: the capture, then the setup-token check; the question they call for, or null.
function planQuestion(key, { run }) {
  const capture = run('billing-capture.mjs', ['--from-claude', '--via', 'login', '--account', key]);
  block('capture', capture);
  const status = run('key-resolve.mjs', ['status', '--account', key]);
  block('key-status', status);
  const parsed = status.code === 0 ? parseKeyStatus(status.stdout) : null;
  if (parsed == null) return null;
  if (parsed.status === 'unlinked') return 'key';
  if (CAPTURE_STATUSES.indexOf(parsed.status) === -1) return null;
  const need = paymentQuestion(capture.stdout);
  return need === 'none' ? null : `payment question=${need}`;
}

// From `from` on, each step's output, stopping at the first one that needs a question; 'backfill' when none does.
async function fromStep(from, key, deps) {
  const { lists } = deps;
  const steps = FROM_STEPS.slice(FROM_STEPS.indexOf(from));
  for (const step of steps) {
    const row = await getAccount(key);
    if (row == null) throw new UserError('That account is not linked on this machine. Run /beezi:login again.');
    if (step === 'here' && hereNeedsRule(row) && await listing('rules', key, () => lists.rules(['--account', key]).then(() => true)) != null) return 'here';
    if (step === 'plan') {
      const question = planQuestion(key, deps);
      if (question != null) return question;
    }
    if (step === 'joined' && await listing('joined', key, () => lists.joined(['--account', key], DEFER)) > 0) return 'joined';
    if (step === 'routes' && await listing('routes', key, () => lists.routes(['--account', key], DEFER)) > 0) return 'routes';
  }
  return 'backfill';
}

// Step 0 and 1, then the setup question: null when the flow stops (the preflight refused or the sign-in failed).
async function start(deps) {
  const { run, live } = deps;
  const preflight = run('login-preflight.mjs', []);
  block('preflight', preflight);
  if (!preflight.stdout.startsWith('✓')) return null;
  console.log('<sign-in>');
  const signIn = await live('login.mjs', []);
  console.log('</sign-in>');
  const line = lastLine(signIn.stdout, /^account=\S+$/);
  if (signIn.code !== 0 || line == null) {
    process.exitCode = 1;
    return null;
  }
  const key = line.slice('account='.length);
  const row = await getAccount(key);
  if (row != null && isMultiTenant(row) && !newFoldersOf(row).set) {
    setupQuestion(row, deps);
    return { key, step: 'setup' };
  }
  return { key, step: await fromStep('here', key, deps) };
}

const DEFAULTS = {
  run: runScript,
  live: runLive,
  lists: { joined, routes, rules },
  pastSessions,
  herePlace: () => placeOfDir(hereDir()),
};

// deps: `run` (captured script), `live` (streamed script), `lists` (the workspace.mjs listings),
// `pastSessions(row, hereKey)` ({ sessions, places }) and `herePlace` (placeOfDir of this session's directory) for the setup question.
export async function loginFlow(argv, deps = {}) {
  const all = { ...DEFAULTS, ...deps };
  const { account, rest } = await parseAccountFlag(argv);
  if (rest.length === 0 && account == null) {
    const started = await start(all);
    if (started == null) next('stop');
    else next(started.step, started.key);
    return;
  }
  if (account == null || rest.length !== 2 || rest[0] !== '--from' || FROM_STEPS.indexOf(rest[1]) === -1) throw new UserError(USAGE);
  next(await fromStep(rest[1], account, all), account);
}

if (isEntryScript(import.meta.url)) {
  loginFlow(process.argv.slice(2)).catch((error) => {
    console.error(`\n✗ ${friendlyMessage(error)}`);
    process.exit(1);
  });
}

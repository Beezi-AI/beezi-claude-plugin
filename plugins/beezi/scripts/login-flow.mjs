import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parseAccountFlag } from '../lib/accounts.mjs';
import { capturePlan } from '../lib/setup-plan.mjs';
import { lastLine, parseListing, report, writeEverything } from '../lib/setup-routing.mjs';
import { applyDefaults, uploadPast } from '../lib/setup-finish.mjs';
import { NO_PLAN, closingLines } from '../lib/setup-finale.mjs';
import { createStyle } from '../lib/setup-style.mjs';
import { AGENT } from '../lib/setup-wizard.mjs';
import { UserError, friendlyMessage } from '../lib/friendly-error.mjs';
import { isEntryScript } from '../lib/entry-script.mjs';

// /beezi:login in two calls, up to the tracking question and then `--from finish`; each output is a block, `next=<step>` last.
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'Usage: login-flow.mjs [--account <ref> --from finish]';
const PLAIN = createStyle({ enabled: false });

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

function next(step, key) {
  console.log(key == null ? `next=${step}` : `next=${step} account=${key}`);
}

// A ctx for the setup helpers that collects what they print.
function collector(run, lines) {
  return { run, print: (line) => { lines.push(line); } };
}

// The silent capture: the plan found, or the line saying it was not, plus any failure the capture printed.
async function planStep(key, run) {
  const lines = [];
  const plan = await capturePlan(collector(run, lines), key);
  lines.push(plan === null ? NO_PLAN : `✓ Plan found: ${plan}`);
  console.log(['<plan>'].concat(lines, ['</plan>']).join('\n'));
}

// The listing, or null when the agent asks the question; else { lead, upload, pastFailed } for the finish step.
async function trackStep(key, run) {
  const result = await run('workspace.mjs', ['setup', '--account', key]);
  if (result.code !== 0) {
    const lead = [];
    report(collector(run, lead), result);
    return { lead, upload: false, pastFailed: true };
  }
  const listing = parseListing(result.stdout);
  if (listing.chosen) return { lead: ['✓ Tracking is already set up (/beezi:settings)'], upload: false };
  if (listing.workspaceCount === 0) return { lead: [], upload: false };
  if (listing.places.length > 0 || listing.workspaceCount > 1) {
    block(`track account="${key}"`, result);
    return null;
  }
  const lead = [];
  if (await writeEverything(collector(run, lead), key, [])) lead.push('✓ Tracking every repo and folder you work in');
  return { lead, upload: false };
}

// The lines the agent shows verbatim: `lead`, the upload's lines, the closing lines; `follow` holds the upload follow's seams.
async function finish(key, run, step, follow) {
  const lines = step.lead.slice();
  const ctx = Object.assign(collector(run, lines), follow);
  if (step.upload) await uploadPast(ctx, key);
  const on = await applyDefaults(ctx);
  const closing = closingLines({
    agent: AGENT, style: PLAIN, crash: on.crash, statusline: on.statusline, planFound: true, pastFailed: step.pastFailed === true,
  });
  console.log(['<finish>'].concat(lines.length === 0 ? closing.slice(1) : lines.concat(closing), ['</finish>']).join('\n'));
  next('done', key);
}

// Step 0 and 1, the plan, then the tracking listing; finishes right away when there is no question to ask.
async function start({ run, live, follow }) {
  const preflight = run('login-preflight.mjs', []);
  block('preflight', preflight);
  if (!preflight.stdout.startsWith('✓')) {
    next('stop');
    return;
  }
  console.log('<sign-in>');
  const signIn = await live('login.mjs', []);
  console.log('</sign-in>');
  const line = lastLine(signIn.stdout, /^account=\S+$/);
  if (signIn.code !== 0 || line == null) {
    process.exitCode = 1;
    next('stop');
    return;
  }
  const key = line.slice('account='.length);
  await planStep(key, run);
  const done = await trackStep(key, run);
  if (done === null) next('track', key);
  else await finish(key, run, done, follow);
}

// deps: `run` (captured script), `live` (streamed script) and `follow` (the upload follow's read, now, sleep and markReported).
export async function loginFlow(argv, deps = {}) {
  const all = { run: runScript, live: runLive, ...deps };
  const { account, rest } = await parseAccountFlag(argv);
  if (rest.length === 0 && account == null) {
    await start(all);
    return;
  }
  if (account == null || rest.length !== 2 || rest[0] !== '--from' || rest[1] !== 'finish') throw new UserError(USAGE);
  await finish(account, all.run, { lead: [], upload: true }, all.follow);
}

if (isEntryScript(import.meta.url)) {
  loginFlow(process.argv.slice(2)).catch((error) => {
    console.error(`\n✗ ${friendlyMessage(error)}`);
    process.exit(1);
  });
}

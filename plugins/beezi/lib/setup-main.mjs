import fs from 'fs';
import os from 'os';
import path from 'path';
import { readSettingsEnv } from './claude-settings-env.mjs';
import { friendlyMessage } from './friendly-error.mjs';
import { hasOauthTokenIdentity } from './oauth-identity.mjs';
import { osEnvOauthToken } from './os-env-token.mjs';
import { headerLines } from './setup-finale.mjs';
import { createPrompt, openTerminal } from './setup-prompt.mjs';
import { createRunner } from './setup-runner.mjs';
import { canReadKeys, formatLine, paint, terminalStyle } from './setup-style.mjs';
import { AGENT, runSetup } from './setup-wizard.mjs';

export const SESSION_KEYS = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID'];
export const NO_TERMINAL = '✗ Beezi setup needs a terminal. Run /beezi:login in Claude Code instead.';
export const STOPPED = 'Setup stopped. Run /beezi:login in Claude Code to finish.';
export const HIDDEN_TOKEN = '⚠ Beezi: your shell sets CLAUDE_CODE_OAUTH_TOKEN, but Claude Code hides it from plugins, '
  + 'so Beezi can’t count usage against that key. To fix that, add the token to the "env" block in ~/.claude/settings.json.';
const OAUTH_TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';
const SHOW_CURSOR = '\x1b[?25h';
const MARGIN = '  ';

export function realDeps(root) {
  return {
    root,
    env: process.env,
    settingsEnv: readSettingsEnv,
    osEnvToken: osEnvOauthToken,
    output: process.stdout,
    openTerminal,
    createPrompt,
    createRunner,
    runSetup,
    makeTempDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-setup-')),
    // Removes the dir when empty; a dir a script wrote into is left for the OS temp cleaner.
    removeDir: (dir) => {
      try {
        fs.rmdirSync(dir);
      } catch (error) { /* not empty, or already gone */ }
    },
    onExit: (handler) => { process.on('exit', handler); },
    onInterrupt: (handler) => { process.on('SIGINT', handler); },
    exit: (code) => { process.exit(code); },
  };
}

// True when the shell's setup token is in neither the settings env block nor the OS environment.
function hiddenShellToken(deps, settings) {
  if (!hasOauthTokenIdentity(deps.env) || hasOauthTokenIdentity(settings)) return false;
  return deps.osEnvToken() == null;
}

// Each non-empty \n-separated part starts at the setup's left margin.
function indent(line) {
  return String(line).split('\n').map((part) => (part === '' ? part : MARGIN + part)).join('\n');
}

// Runs the wizard on the terminal and resolves its exit code; the header is left to the installer when it ran the setup.
export function setupMain(deps) {
  const output = deps.output;
  const style = terminalStyle({ stream: output, env: deps.env });
  // Wrapped to the width on a terminal; a log keeps each line whole.
  const format = (line) => (output.isTTY ? formatLine(style, indent(line), output.columns || 80) : paint(style, indent(line)));
  // `end` '' leaves the cursor on the line, for a line redrawn in place.
  const print = (line, end = '\n') => { output.write(`${format(line)}${end}`); };
  if (deps.env.BEEZI_INSTALLER !== '1') headerLines({ agent: AGENT, style }).forEach((line) => { output.write(`${line}\n`); });
  const input = deps.openTerminal();
  if (input === null) {
    print(NO_TERMINAL);
    return Promise.resolve(1);
  }
  const cwd = deps.makeTempDir();
  deps.onExit(() => deps.removeDir(cwd));
  // Shows the cursor again on process exit.
  if (output.isTTY) deps.onExit(() => { output.write(SHOW_CURSOR); });
  let run = null;
  // Set by the upload follow: while it follows, Ctrl+C ends only the following.
  const interrupt = { following: false, stopped: false };
  // Shared by SIGINT and Ctrl+C inside an arrow-key menu; a drawn activity line is cleared first.
  const stop = () => {
    if (interrupt.following) {
      interrupt.stopped = true;
      return;
    }
    if (run !== null) run.clearActivity();
    print('');
    print(STOPPED);
    deps.exit(130);
  };
  deps.onInterrupt(stop);
  const interactive = canReadKeys({ input, output, env: deps.env });
  const ask = deps.createPrompt({ input, output, style, interactive, onInterrupt: stop, format });
  // The settings env block over the shell's, without the setup token, as Claude Code gives its hooks.
  const settings = deps.settingsEnv();
  const env = Object.assign({}, deps.env, settings);
  delete env[OAUTH_TOKEN];
  const activity = output.isTTY === true && deps.env.TERM !== 'dumb';
  run = deps.createRunner({
    root: deps.root, cwd, env, sessionKeys: SESSION_KEYS, paint: format,
    output, activity, margin: MARGIN, accent: style.accent,
  });
  const progress = (label) => { run.setLabel(label); };
  const notices = hiddenShellToken(deps, settings) ? [HIDDEN_TOKEN] : [];
  return deps.runSetup({ run, ask, print, progress, style, notices, output, activity, interrupt })
    .catch((error) => {
      print(`✗ ${friendlyMessage(error)}`);
      return 1;
    })
    .then((code) => {
      ask.close();
      return code;
    });
}

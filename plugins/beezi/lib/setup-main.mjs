import fs from 'fs';
import os from 'os';
import path from 'path';
import { readSettingsEnv } from './claude-settings-env.mjs';
import { friendlyMessage } from './friendly-error.mjs';
import { finaleLines } from './setup-finale.mjs';
import { createPrompt, openTerminal } from './setup-prompt.mjs';
import { createRunner } from './setup-runner.mjs';
import { canReadKeys, colorEnabled, createStyle, paint } from './setup-style.mjs';
import { runSetup } from './setup-wizard.mjs';

export const SESSION_KEYS = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID'];
export const NO_TERMINAL = '✗ Beezi setup needs a terminal. Run /beezi:login in Claude Code instead.';
export const STOPPED = 'Setup stopped. Run the installer again, or /beezi:login in Claude Code, to finish.';
const AGENT = 'Claude Code';
const SHOW_CURSOR = '\x1b[?25h';

export function realDeps(root) {
  return {
    root,
    env: process.env,
    settingsEnv: readSettingsEnv,
    output: process.stdout,
    random: Math.random,
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

// Runs the wizard on the terminal and resolves its exit code.
export function setupMain(deps) {
  const output = deps.output;
  const style = createStyle({ enabled: colorEnabled({ stream: output, env: deps.env }) });
  const print = (line) => { output.write(`${paint(style, line)}\n`); };
  const input = deps.openTerminal();
  if (input === null) {
    print(NO_TERMINAL);
    return Promise.resolve(1);
  }
  const cwd = deps.makeTempDir();
  deps.onExit(() => deps.removeDir(cwd));
  // Shows the cursor again on process exit.
  if (output.isTTY) deps.onExit(() => { output.write(SHOW_CURSOR); });
  // Shared by SIGINT and Ctrl+C inside an arrow-key menu.
  const stop = () => {
    print('');
    print(STOPPED);
    deps.exit(130);
  };
  deps.onInterrupt(stop);
  const interactive = canReadKeys({ input, output, env: deps.env });
  const ask = deps.createPrompt({ input, output, style, interactive, onInterrupt: stop });
  // The settings env block over the shell's, as Claude Code gives its hooks.
  const env = Object.assign({}, deps.env, deps.settingsEnv());
  const run = deps.createRunner({
    root: deps.root, cwd, env, sessionKeys: SESSION_KEYS, paint: (line) => paint(style, line),
  });
  return deps.runSetup({ run, ask, print })
    .catch((error) => {
      print(`✗ ${friendlyMessage(error)}`);
      return 1;
    })
    .then((code) => {
      ask.close();
      if (code === 0) {
        finaleLines({ agent: AGENT, style, columns: output.columns || 80, random: deps.random })
          .forEach((line) => { output.write(`${line}\n`); });
      }
      return code;
    });
}

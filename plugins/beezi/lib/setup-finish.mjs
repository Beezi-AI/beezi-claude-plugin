import { usableAccounts } from './setup-account.mjs';
import { lastLine, report, token } from './setup-routing.mjs';

export const FINALIZED = 'your history pull is finalized.';
export const FINALIZE_NOTE = 'History import is now closed for this account: past sessions on other machines can no longer be imported. New sessions are still tracked everywhere Beezi is installed.';
export const DEFAULT_UNCHANGED = 'The default account is unchanged. /beezi:settings account switches it later.';
export const CRASH_QUESTION = 'How should Beezi crash reports work?';
export const STATUS_LINE_QUESTION = "Show Beezi in Claude Code's status line?";
export const UPLOAD_LABEL = 'Uploading past sessions…';
// backfill.mjs prints this once per batch; the wizard shows it on the activity line instead.
export const UPLOAD_PROGRESS = /^Beezi: (\d+)\/(\d+) sessions read…$/;
const CRASH_OPTIONS = [
  { label: 'Correlate (recommended)', description: 'Crash reports with an installation ID, so support can find yours', mode: 'correlate' },
  { label: 'On', description: 'Crash reports without an installation ID', mode: 'on' },
  { label: 'Off', description: 'No crash reports; pending ones are deleted', mode: 'off' },
  { label: 'Anonymous', description: 'Stay on, and delete the installation ID and the reports that carry it', mode: 'anonymous' },
];

export async function uploadHistory(ctx, key) {
  const result = await ctx.run('backfill.mjs', ['--via', 'login', '--account', key], { stream: true, label: UPLOAD_LABEL, live: UPLOAD_PROGRESS });
  if (result.stdout.indexOf(FINALIZED) !== -1) ctx.print(FINALIZE_NOTE);
}

export async function offerDefault(ctx, account) {
  if (!account.readsElsewhere) return;
  const listing = await ctx.run('accounts.mjs', ['list']);
  const row = usableAccounts(listing.stdout).find((a) => a.key === account.key);
  const name = row === undefined ? 'the account you just linked' : row.description;
  const yes = await ctx.ask.confirm(`Make ${name} the account /beezi:analytics reads from?`, false);
  if (yes === true) report(ctx, await ctx.run('accounts.mjs', ['use', account.key]));
  if (yes === false) ctx.print(DEFAULT_UNCHANGED);
}

// The options with the current mode marked as the default.
export function crashChoice(current) {
  const options = CRASH_OPTIONS.map((option) => (option.mode === current
    ? { label: option.label, description: `${option.description}, current setting`, mode: option.mode }
    : option));
  return { options, defaultIndex: CRASH_OPTIONS.findIndex((option) => option.mode === current) };
}

// Runs telemetry.mjs for every answer, the current mode included.
async function askCrashReports(ctx, current) {
  const choice = crashChoice(current);
  const picked = await ctx.ask.choose(CRASH_QUESTION, choice.options, { defaultIndex: choice.defaultIndex });
  if (picked === null) return;
  report(ctx, await ctx.run('telemetry.mjs', [choice.options[picked].mode]));
}

// Crash reports, then the status line when it is off, from `settings.mjs keys`.
export async function askMachineSettings(ctx) {
  const keys = await ctx.run('settings.mjs', ['keys']);
  if (keys.code !== 0) {
    report(ctx, keys);
    return;
  }
  const line = lastLine(keys.stdout, /^crash=/);
  if (line === null) return;
  await askCrashReports(ctx, token(line, 'crash'));
  if (token(line, 'statusline') !== 'off') return;
  if (await ctx.ask.confirm(STATUS_LINE_QUESTION, true) === true) {
    report(ctx, await ctx.run('statusline-install.mjs', []));
  }
}

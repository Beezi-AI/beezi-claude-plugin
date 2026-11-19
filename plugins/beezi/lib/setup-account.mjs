import { lastLine, outputLines, report, token } from './setup-routing.mjs';

export const NETWORK_ERRORS = ['Could not reach the Beezi server', 'The login server took too long'];
const SIGN_IN_LABEL = 'Waiting for you to sign in in your browser';
const ACCOUNT_LINE = /^\d+\. (.+?)(?: \[([^\]]+)\])? key=(\S+)$/;
const WORKSPACE_SEPARATOR = ' · ';
// login.mjs lines the setup's own "Signed in" line replaces; the browser link and failures still show.
const LOGIN_HIDDEN = /^(account=|✓ Beezi analytics linked as |✓ This machine is already linked as | {2}\/beezi:analytics still reads from |Beezi analytics — link an account$|\s*$)/;

// Linked, non-revoked rows of `accounts.mjs list`: "<n>. <description>[ [flags]] key=<key>".
export function usableAccounts(text) {
  const accounts = [];
  outputLines(text).forEach((line) => {
    const found = ACCOUNT_LINE.exec(line);
    if (found === null) return;
    const flags = found[2] ? found[2].split(', ') : [];
    if (flags.indexOf('revoked') === -1) {
      accounts.push({ description: found[1], key: found[3], isDefault: flags.indexOf('default') !== -1 });
    }
  });
  return accounts;
}

// The key a login.mjs run linked; null when the sign-in did not finish.
export function signInKey(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  const line = lastLine(result.stdout, /^account=\S+$/);
  const offline = NETWORK_ERRORS.some((text) => output.indexOf(text) !== -1);
  if (result.code !== 0 || line === null || offline) return null;
  return token(line, 'account');
}

async function listAccounts(ctx) {
  const listing = await ctx.run('accounts.mjs', ['list']);
  if (listing.code !== 0) report(ctx, listing);
  return usableAccounts(listing.stdout);
}

// The default usable account, else the first one, else a browser sign-in; null when the sign-in did not finish.
export async function chooseAccount(ctx) {
  const accounts = await listAccounts(ctx);
  const preferred = accounts.filter((a) => a.isDefault).concat(accounts);
  if (preferred.length > 0) return preferred[0];
  const key = signInKey(await ctx.run('login.mjs', [], { stream: true, hide: LOGIN_HIDDEN, label: SIGN_IN_LABEL }));
  if (key === null) return null;
  const linked = (await listAccounts(ctx)).filter((a) => a.key === key);
  return linked.length > 0 ? linked[0] : { key, description: null, isDefault: false };
}

// "✓ Signed in as <email>" (names bold), with ", workspace <name>" for a one-workspace account, from its `settings.mjs keys` row.
export async function signedInLine(ctx, account) {
  const keys = await ctx.run('settings.mjs', ['keys']);
  const row = outputLines(keys.stdout).filter((line) => line.indexOf(`account=${account.key} `) === 0)[0];
  const email = row === undefined ? null : token(row, 'email');
  const at = account.description === null ? -1 : account.description.indexOf(WORKSPACE_SEPARATOR);
  const one = row !== undefined && token(row, 'workspaces') === '1' && at !== -1;
  const who = email !== null && email !== 'unknown' ? ` as ${ctx.style.bold(email)}` : '';
  return `✓ Signed in${who}${one ? `, workspace ${ctx.style.bold(account.description.slice(at + WORKSPACE_SEPARATOR.length))}` : ''}`;
}

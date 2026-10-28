import { lastLine, outputLines, report, token } from './setup-routing.mjs';

export const ACCOUNT_QUESTION = 'This machine is already linked to Beezi. Which account should setup use?';
export const NETWORK_ERRORS = ['Could not reach the Beezi server', 'The login server took too long'];
export const STILL_READS = '/beezi:analytics still reads from';
export const SIGN_IN_LABEL = 'Waiting for you to sign in in your browser…';
const KEEP_ACCOUNT = 'Keep this account; no browser sign-in';
const LINK_ANOTHER = { label: 'Link another account', description: 'Sign in through your browser' };
const ACCOUNT_LINE = /^\d+\. (.+?)(?: \[([^\]]+)\])? key=(\S+)$/;

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

// The account a login.mjs run linked; null when the sign-in did not finish.
export function signInResult(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  const line = lastLine(result.stdout, /^account=\S+$/);
  const offline = NETWORK_ERRORS.some((text) => output.indexOf(text) !== -1);
  if (result.code !== 0 || line === null || offline) return null;
  return { key: token(line, 'account'), readsElsewhere: result.stdout.indexOf(STILL_READS) !== -1 };
}

export async function signIn(ctx) {
  return signInResult(await ctx.run('login.mjs', [], { stream: true, hide: /^account=/, label: SIGN_IN_LABEL }));
}

// A linked account the user picks, else a fresh sign-in; null stops setup.
export async function chooseAccount(ctx) {
  const listing = await ctx.run('accounts.mjs', ['list']);
  if (listing.code !== 0) report(ctx, listing);
  const usable = usableAccounts(listing.stdout);
  // The default account first, then the rest in listed order.
  const accounts = usable.filter((a) => a.isDefault).concat(usable.filter((a) => !a.isDefault));
  if (accounts.length === 0) return signIn(ctx);
  const options = accounts.map((a) => ({ label: `Continue with ${a.description}`, description: KEEP_ACCOUNT })).concat([LINK_ANOTHER]);
  const choice = await ctx.ask.choose(ACCOUNT_QUESTION, options, { defaultIndex: 0 });
  if (choice === null) return null;
  if (choice === accounts.length) return signIn(ctx);
  return { key: accounts[choice].key, readsElsewhere: false };
}

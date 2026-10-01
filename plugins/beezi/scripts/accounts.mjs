import { AccountStatus, describeAccount, getDefaultKey, listAccounts, resolveAccountRef, setDefault } from '../lib/accounts.mjs';
import { UserError, friendlyMessage } from '../lib/friendly-error.mjs';

async function list() {
  const accounts = await listAccounts();
  const def = await getDefaultKey();
  if (accounts.length === 0) {
    console.log('Beezi: this machine is not linked. Run /beezi:login to link an account.');
    return;
  }
  accounts.forEach((a, i) => {
    const flags = [a.key === def ? 'default' : null, a.status === AccountStatus.REVOKED ? 'revoked' : null].filter(Boolean);
    console.log(`${i + 1}. ${describeAccount(a)}${flags.length ? ` [${flags.join(', ')}]` : ''} key=${a.key}`);
  });
  if (def == null) console.log('No default account is set — /beezi:analytics has nothing to read from.');
}

async function use(ref) {
  const key = await resolveAccountRef(ref);
  const row = (await listAccounts()).find((a) => a.key === key);
  if (row.status === AccountStatus.REVOKED) throw new UserError(`${describeAccount(row)} is revoked — run /beezi:login and sign in as it first.`);
  await setDefault(key);
  console.log(`✓ /beezi:analytics now reads from ${describeAccount(row)}.`);
  console.log('  If the analytics tools look wrong after switching workspaces, start a new Claude Code session.');
}

async function main() {
  const [cmd, ref] = process.argv.slice(2);
  if (cmd === 'list' || cmd == null) { await list(); return; }
  if (cmd === 'use') {
    if (!ref) throw new UserError('Usage: accounts.mjs use <key|email|n>');
    await use(ref);
    return;
  }
  throw new UserError(`Unknown command "${cmd}". Usage: accounts.mjs list | use <key|email|n>`);
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});

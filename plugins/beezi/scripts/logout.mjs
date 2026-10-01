import { runLogout } from '../lib/logout.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') options.all = true;
    else if (args[i] === '--list') options.list = true;
    else if (args[i] === '--account' || args[i] === '--next-default') {
      const field = args[i] === '--account' ? 'account' : 'nextDefault';
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${args[i]} needs a value.`);
      options[field] = args[++i];
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (options.all && options.account) throw new Error('Choose --all or --account, not both.');
  return runLogout({}, options);
}
main()
  .then((lines) => { for (const line of lines) console.log(line); })
  .catch((error) => {
    console.error(`\n✗ ${friendlyMessage(error)}`);
    process.exit(1);
  });

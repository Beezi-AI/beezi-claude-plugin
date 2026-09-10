import { runLogout } from '../lib/logout.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

runLogout()
  .then((lines) => { for (const line of lines) console.log(line); })
  .catch((error) => {
    console.error(`\n✗ ${friendlyMessage(error)}`);
    process.exit(1);
  });

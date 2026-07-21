import { readHookInput } from '../lib/hook-input.mjs';
import { runSessionStart } from '../lib/session-start.mjs';

const input = readHookInput();
if (!input) process.exit(0);
runSessionStart(input)
  .then((msg) => { if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg })); })
  .catch(() => {})
  .finally(() => process.exit(0));

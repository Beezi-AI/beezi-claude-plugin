// Stdio entry for the Beezi MCP server: Claude Code runs this instead of
// connecting to the portal directly, so the stored /beezi:login credentials
// authenticate MCP too — no separate OAuth prompt. Logic in lib/mcp-bridge.mjs.
import readline from 'node:readline';
import { createBridge } from '../lib/mcp-bridge.mjs';

const bridge = createBridge({ write: (line) => process.stdout.write(`${line}\n`) });
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  void bridge.handleLine(line);
});
rl.on('close', () => process.exit(0));

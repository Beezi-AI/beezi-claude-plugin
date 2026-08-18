import { installStatusline, uninstallStatusline } from '../lib/statusline-install.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

try {
  const { ok, message } = process.argv.includes('--uninstall')
    ? uninstallStatusline()
    : installStatusline();
  console.log(`${ok ? '✓' : '✗'} ${message}`);
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
}

import path from 'path';
import { fileURLToPath } from 'url';
import { realDeps, setupMain } from '../lib/setup-main.mjs';

// Terminal setup run by the installers: node <plugin root>/scripts/setup.mjs
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

setupMain(realDeps(root)).then((code) => {
  process.exit(code);
});

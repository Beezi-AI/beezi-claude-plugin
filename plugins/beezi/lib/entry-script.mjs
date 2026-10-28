import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// True when the module at `url` is the script node was started with; real paths, so a symlink or another letter case still matches.
export function isEntryScript(url) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync.native(path.resolve(process.argv[1])) === fs.realpathSync.native(fileURLToPath(url));
  } catch {
    return false;
  }
}

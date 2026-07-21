import fs from 'node:fs';
import path from 'node:path';

// Read + parse a JSON file, or return `fallback` on any read/parse failure.
export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

// Write JSON to a 0600 file, creating parent dirs. writeFileSync only applies `mode`
// on creation, so chmod is forced to keep an overwrite 0600 (no-op on Windows).
export function writeJsonSecure(filePath, obj, { dirMode = 0o700 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: dirMode });
  fs.writeFileSync(filePath, JSON.stringify(obj), { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* no-op on Windows */
  }
}

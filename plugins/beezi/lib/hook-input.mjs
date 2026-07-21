import fs from 'node:fs';

export function isGitCheckpointCommand(cmd) {
  return /git\s+(commit|switch|checkout)\b/.test(cmd);
}

// Parse the hook's JSON payload from stdin (fd 0). Returns null on any read/parse
// failure so the caller can exit quietly — a hook must never throw on bad input.
export function readHookInput(fd = 0) {
  try {
    return JSON.parse(fs.readFileSync(fd, 'utf-8'));
  } catch {
    return null;
  }
}

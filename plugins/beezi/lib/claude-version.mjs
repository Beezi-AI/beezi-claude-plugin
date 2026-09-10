import fs from 'fs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { telemetryConsentFile } from './paths.mjs';

const TAIL_BYTES = 64 * 1024;
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,39}$/;  // 2.1.251, 0.16.2, 1.0.0-beta.3

// Claude Code stamps its version on most transcript lines. Read the last chunk and take the
// newest one; there is no environment variable or hook-input field carrying it.
export function readClaudeCodeVersion(transcriptPath) {
  try {
    const { size } = fs.statSync(transcriptPath);
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i] || lines[i].indexOf('"version"') === -1) continue;
        try {
          const parsed = JSON.parse(lines[i]);
          if (typeof parsed.version === 'string') return parsed.version;
        } catch { /* partial first line, or not JSON */ }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* no transcript */ }
  return null;
}

// Cached alongside consent so recordIssue never has to touch a transcript.
export function rememberClaudeCodeVersion(transcriptPath) {
  const raw = readClaudeCodeVersion(transcriptPath);
  const version = raw != null && VERSION.test(raw) ? raw : null;
  if (!version) return;
  const state = readJson(telemetryConsentFile());
  if (state == null || state.claudeCodeVersion === version) return;
  writeJsonSecure(telemetryConsentFile(), { ...state, claudeCodeVersion: version });
}

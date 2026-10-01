import { listAllTranscripts } from './transcript-index.mjs';
import { scanCoworkCache } from './cowork-cache.mjs';

// Cowork records already carry cumulative accounting; do not manufacture JSONL files.
// Their runtime session UUID is shared with the engine, preventing a second Code projection.
export function listAnalyticsSessions(deps = {}) {
  const list = deps.listTranscripts == null ? listAllTranscripts : deps.listTranscripts;
  const scan = deps.scanCoworkCache == null ? scanCoworkCache : deps.scanCoworkCache;
  const byId = new Map(list().map((entry) => [entry.sessionId, entry]));
  let warningCount = 0;
  try {
    const found = scan();
    warningCount = Array.isArray(found.warnings) ? found.warnings.length : 0;
    for (const entry of found.sessions) byId.set(entry.sessionId, entry);
  } catch { warningCount = 1; }
  const entries = [...byId.values()].sort((a, b) => a.mtimeMs - b.mtimeMs);
  if (warningCount > 0) Object.defineProperty(entries, 'coworkWarnings', { value: warningCount });
  return entries;
}

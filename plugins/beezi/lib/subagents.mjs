import fs from 'node:fs';
import path from 'node:path';

// Read the sibling agent-<id>.meta.json Claude Code writes next to each subagent transcript.
// Holds { agentType, spawnDepth, toolUseId }. Missing/malformed meta yields nulls so the
// caller can still process the transcript (identity fields just go unlabelled). toolUseId joins
// back to the spawning Task tool_use block in the main transcript (its `description` is the
// agent's display name — see buildTaskDescriptionMap).
function readAgentMeta(dir, agentId) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${agentId}.meta.json`), 'utf-8'));
    return {
      agentType: typeof meta?.agentType === 'string' ? meta.agentType : null,
      spawnDepth: typeof meta?.spawnDepth === 'number' ? meta.spawnDepth : null,
      toolUseId: typeof meta?.toolUseId === 'string' ? meta.toolUseId : null,
    };
  } catch {
    return { agentType: null, spawnDepth: null, toolUseId: null };
  }
}

// Map each Task tool_use block id → its human-authored `description` (the short label the spawner
// gives a subagent, e.g. "Explore analytics plugin"). Scans the MAIN transcript once; a subagent's
// meta.json.toolUseId joins back to these to resolve its display name. Empty Map on any read/parse
// failure — names just go unresolved, never throw.
export function buildTaskDescriptionMap(transcriptPath) {
  const map = new Map();
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return map;
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use' || block.name !== 'Task' || !block.id) continue;
      const desc = block.input?.description;
      if (typeof desc === 'string' && desc.trim()) map.set(block.id, desc.trim());
    }
  }
  return map;
}

// Claude Code writes each subagent's turns to a separate transcript at
// <transcriptDir>/<sessionId>/subagents/agent-<id>.jsonl (the main session file
// contains no sidechain lines). Nested agents (spawnDepth > 1) land in the same
// flat directory. Returns [{ agentId, path, agentType, spawnDepth, toolUseId }] sorted by
// agentId for stable order.
export function listSubagentTranscripts(transcriptPath, sessionId) {
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const agentId = f.slice(0, -'.jsonl'.length);
      return { agentId, path: path.join(dir, f), ...readAgentMeta(dir, agentId) };
    })
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

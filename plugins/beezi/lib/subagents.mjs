import fs from 'fs';
import path from 'path';

// A subagent transcript at either depth. Matching the prefix, not just the extension,
// is what keeps a workflow run's journal.jsonl from being read as an agent.
const AGENT_FILE_RE = /^agent-.*\.jsonl$/;
const WORKFLOWS_DIR = 'workflows';

// Read the sibling agent-<id>.meta.json Claude Code writes next to each subagent transcript.
// Holds { agentType, spawnDepth, toolUseId }. Missing/malformed meta yields nulls so the
// caller can still process the transcript (identity fields just go unlabelled). toolUseId joins
// back to the spawning Task tool_use block in the main transcript (its `description` is the
// agent's display name — see buildTaskDescriptionMap).
function readAgentMeta(dir, agentId) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${agentId}.meta.json`), 'utf-8'));
    return {
      agentType: meta != null && typeof meta.agentType === 'string' ? meta.agentType : null,
      spawnDepth: meta != null && typeof meta.spawnDepth === 'number' ? meta.spawnDepth : null,
      toolUseId: meta != null && typeof meta.toolUseId === 'string' ? meta.toolUseId : null,
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
    const message = rec == null ? undefined : rec.message;
    const content = message == null ? undefined : message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block == null || block.type !== 'tool_use' || block.name !== 'Task' || !block.id) continue;
      const desc = block.input == null ? undefined : block.input.description;
      if (typeof desc === 'string' && desc.trim()) map.set(block.id, desc.trim());
    }
  }
  return map;
}

// A workflow run records its own agents in <transcriptDir>/<sessionId>/workflows/<wf_id>.json:
// a top-level workflowName plus one workflowProgress entry per agent carrying its label. That is
// the only name source for these agents — their meta has no toolUseId and their ids never reach
// the main transcript, so buildTaskDescriptionMap resolves none of them.
//
// Returns (workflowId, agentId) -> display name, or null. Reads each run's file at most once and
// only when one of its agents is actually seen, so a session without workflow agents does no I/O.
export function createWorkflowNameResolver(transcriptPath, sessionId) {
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'workflows');
  const cache = new Map();

  const load = (workflowId) => {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(path.join(dir, `${workflowId}.json`), 'utf-8'));
    } catch {
      return null;
    }
    if (state == null) return null;
    const workflowName = typeof state.workflowName === 'string' && state.workflowName.trim()
      ? state.workflowName.trim()
      : null;
    const byAgent = new Map();
    const progress = Array.isArray(state.workflowProgress) ? state.workflowProgress : [];
    for (const entry of progress) {
      if (entry == null || entry.type !== 'workflow_agent') continue;
      if (typeof entry.agentId !== 'string' || !entry.agentId) continue;
      const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : null;
      // workflowProgress records the id bare; the transcript filename carries an agent- prefix.
      byAgent.set(`agent-${entry.agentId}`, label);
    }
    return { workflowName, byAgent };
  };

  return (workflowId, agentId) => {
    if (!workflowId) return null;
    if (!cache.has(workflowId)) cache.set(workflowId, load(workflowId));
    const run = cache.get(workflowId);
    if (run == null) return null;
    const label = run.byAgent.get(agentId);
    // An agent absent from the progress list (a retry or resume that was never recorded) still
    // names its run, which beats no name at all.
    if (!label) return run.workflowName;
    return run.workflowName ? `${run.workflowName}:${label}` : label;
  };
}

// Claude Code writes each subagent's turns to a separate transcript at
// <transcriptDir>/<sessionId>/subagents/agent-<id>.jsonl (the main session file contains no
// sidechain lines). Task-spawned agents sit flat in that directory whatever their spawnDepth;
// Workflow-tool agents shard one level deeper, under workflows/<wf_id>/. Both are collected.
// Returns [{ agentId, path, workflowId, agentType, spawnDepth, toolUseId }] sorted by agentId
// for stable order; workflowId is null for flat agents.
export function listSubagentTranscripts(transcriptPath, sessionId) {
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  const collect = (fromDir, name, workflowId) => {
    const agentId = name.slice(0, -'.jsonl'.length);
    found.push({
      agentId,
      path: path.join(fromDir, name),
      workflowId,
      ...readAgentMeta(fromDir, agentId),
    });
  };

  for (const entry of entries) {
    if (entry.isFile() && AGENT_FILE_RE.test(entry.name)) {
      collect(dir, entry.name, null);
      continue;
    }
    if (!entry.isDirectory() || entry.name !== WORKFLOWS_DIR) continue;
    // Two hard-coded levels rather than a recursive walk: a workflow directory also holds a
    // journal.jsonl, and a generic walk would report that as an agent called "journal".
    const workflowsDir = path.join(dir, WORKFLOWS_DIR);
    let runs;
    try {
      runs = fs.readdirSync(workflowsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const run of runs) {
      if (!run.isDirectory()) continue;
      const runDir = path.join(workflowsDir, run.name);
      let files;
      try {
        files = fs.readdirSync(runDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.isFile() && AGENT_FILE_RE.test(file.name)) collect(runDir, file.name, run.name);
      }
    }
  }
  return found.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

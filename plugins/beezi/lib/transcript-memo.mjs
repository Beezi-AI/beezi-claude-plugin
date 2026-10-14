import fs from 'fs';
import { parseTranscriptLines } from './delta.mjs';
import { listSubagentTranscripts } from './subagents.mjs';
import { timestampsOf } from './session-timeline.mjs';

// One audit session's transcript reads: the main file parsed once and kept until clear(), each agent file parsed once keeping only its timestamps.
export function createTranscriptMemo(deps = {}) {
  const readFile = deps.readFile == null ? ((p) => fs.readFileSync(p, 'utf-8')) : deps.readFile;
  const listSubagents = deps.listSubagents == null ? listSubagentTranscripts : deps.listSubagents;
  let mainPath = null;
  let mainView = null;
  let agentsKey = null;
  let agents = null;
  let agentTimes = new Map();

  // The main transcript's whole-file records, read on first request; a failed read is not kept.
  const main = (transcriptPath) => {
    if (mainView != null && mainPath === transcriptPath) return mainView;
    mainView = null; // drop another file's records before parsing this one
    mainView = parseTranscriptLines(readFile(transcriptPath), 0);
    mainPath = transcriptPath;
    return mainView;
  };

  // An agent file's whole-file records for its delta; only their timestamps outlive the call.
  const agent = (agentPath) => {
    const view = parseTranscriptLines(readFile(agentPath), 0);
    agentTimes.set(agentPath, timestampsOf(view.records.map((r) => r.line)));
    return view;
  };

  // Hands an agent's timestamps over once, or null when no delta parsed that file.
  const takeAgentTimes = (agentPath) => {
    if (!agentTimes.has(agentPath)) return null;
    const times = agentTimes.get(agentPath);
    agentTimes.delete(agentPath);
    return times;
  };

  // The session's subagent list, listed once for the checkpoint and the timeline.
  const subagents = (transcriptPath, sessionId) => {
    const key = `${transcriptPath}\n${sessionId}`;
    if (agents == null || agentsKey !== key) {
      agents = listSubagents(transcriptPath, sessionId);
      agentsKey = key;
    }
    return agents;
  };

  const clear = () => {
    mainPath = null;
    mainView = null;
    agentsKey = null;
    agents = null;
    agentTimes = new Map();
  };

  return { main, agent, takeAgentTimes, subagents, clear };
}

import os from 'node:os';
import path from 'node:path';

export function beeziHome() {
  return process.env.BEEZI_HOME ?? path.join(os.homedir(), '.beezi');
}

export function queueDir() {
  return path.join(beeziHome(), 'queue');
}

export function stateDir() {
  return path.join(beeziHome(), 'state');
}

// Persisted known-repo-root map (dir→root resolution cache/seed). One JSON for the machine.
export function repoMapFile() {
  return path.join(beeziHome(), 'repo-map.json');
}

export function credentialsFile() {
  return path.join(beeziHome(), 'credentials.json');
}

export function billingConfigFile() {
  return path.join(beeziHome(), 'billing.json');
}

// Claude Code's config root — `~/.claude`, relocatable via CLAUDE_CONFIG_DIR. Single source
// for the dirs the plugin reads out of Claude Code (transcripts, live session store).
export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function claudeProjectsDir() {
  return path.join(claudeHome(), 'projects');
}

export function claudeSessionsDir() {
  return path.join(claudeHome(), 'sessions');
}

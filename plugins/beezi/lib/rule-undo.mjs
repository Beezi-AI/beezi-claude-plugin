import fs from 'fs';
import { ruleUndoFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

const UNDO_VERSION = 1;

// The routing an undo puts back: raw copies of the row's rules and New folders (null when unset).
export function routingOf(row) {
  const raw = {
    workspaceRules: row != null && Array.isArray(row.workspaceRules) ? row.workspaceRules : [],
    newFolders: row != null && row.newFolders != null ? row.newFolders : null,
  };
  return JSON.parse(JSON.stringify(raw));
}

export function sameRouting(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Keeps only the newest change: { version, at, account, summary, change, was, before, after }; `change` and `was` (a set's old target, else null) build the undo line.
export function recordUndo({ account, summary, change, was = null, before, after }) {
  writeJsonSecure(ruleUndoFile(), { version: UNDO_VERSION, at: new Date().toISOString(), account, summary, change, was, before, after });
}

// The recorded change, or null when there is none (or it is unreadable).
export function readUndo() {
  const raw = readJson(ruleUndoFile(), null);
  if (raw == null || raw.version !== UNDO_VERSION || typeof raw.account !== 'string' || typeof raw.change !== 'string') return null;
  if (raw.was != null && typeof raw.was !== 'string') return null;
  if (raw.before == null || raw.after == null || !Array.isArray(raw.before.workspaceRules) || !Array.isArray(raw.after.workspaceRules)) return null;
  return raw;
}

export function clearUndo() {
  try { fs.rmSync(ruleUndoFile(), { force: true }); } catch { /* best-effort */ }
}

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { coworkPrimaryKey, decodeIndexedValue, decodeManifest, decodeTable, mergeEntry, replayWal } from './cowork-leveldb.mjs';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Polling hint only: decoding still verifies a coherent CURRENT/manifest snapshot.
// Reading CURRENT and statting candidate data files avoids decoding unchanged caches.
export function getCoworkCacheFingerprint(options = {}) {
  const roots = options.roots || discoverCoworkRoots(options), stamps = [];
  for (const root of Array.from(new Set(roots)).sort()) {
    const dir = path.join(root, 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb');
    if (!fs.existsSync(dir)) continue;
    const currentPath = path.join(dir, 'CURRENT'), before = fs.lstatSync(currentPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 256) throw Error('Unsupported CURRENT manifest');
    const current = fs.readFileSync(currentPath, 'utf8').trim();
    if (!/^MANIFEST-[0-9]+$/.test(current) || fingerprint(before) !== fingerprint(fs.lstatSync(currentPath))) throw Error('Cowork cache changed during fingerprint');
    const names = fs.readdirSync(dir); if (names.length > 10000) throw Error('Cowork cache file limit');
    const relevant = names.filter(name => name === 'CURRENT' || name === current || /^[0-9]+\.(?:log|ldb|sst)$/.test(name)).sort();
    if (!relevant.includes(current)) throw Error('Cowork cache changed during fingerprint');
    stamps.push(dir);
    for (const name of relevant) {
      const stat = fs.lstatSync(path.join(dir, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Unsupported cache file');
      stamps.push(name + ':' + fingerprint(stat));
    }
  }
  return stamps.length ? crypto.createHash('sha256').update(JSON.stringify(stamps)).digest('hex') : null;
}
export function discoverCoworkRoots(options = {}) {
  const platform = options.platform || process.platform, env = options.env || process.env, home = options.home || os.homedir();
  const roots = [];
  if (platform === 'darwin') roots.push(path.posix.join(home, 'Library', 'Application Support', 'Claude'));
  if (platform === 'win32') {
    if (env.APPDATA) roots.push(path.join(env.APPDATA, 'Claude'));
    if (env.LOCALAPPDATA) {
      const packages = path.join(env.LOCALAPPDATA, 'Packages');
      try { for (const name of fs.readdirSync(packages)) if (/^Claude_[a-z0-9]+$/i.test(name)) roots.push(path.join(packages, name, 'LocalCache', 'Roaming', 'Claude')); } catch (_) { /* App may not be installed. */ }
    }
  }
  return roots;
}
function iso(value) { const n = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(n) && n >= 0 ? new Date(n).toISOString() : null; }
function nonnegative(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function safeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw Error('Invalid Cowork modelUsage');
  const out = {};
  for (const model of Object.keys(usage)) {
    if (model.length > 200 || model === '__proto__' || model === 'constructor' || model === 'prototype') throw Error('Invalid Cowork model identifier');
    const entry = usage[model]; if (!entry || typeof entry !== 'object') throw Error('Invalid Cowork model usage');
    const clean = {};
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD']) {
      if (!nonnegative(entry[key]) || (key !== 'costUSD' && !Number.isSafeInteger(entry[key]))) throw Error('Invalid Cowork usage counter'); clean[key] = entry[key];
    }
    for (const key of ['thinkingTokens', 'webSearchRequests', 'contextWindow', 'maxOutputTokens']) if (entry[key] !== undefined) { if (!nonnegative(entry[key])) throw Error('Invalid Cowork usage counter'); clean[key] = entry[key]; }
    out[model] = clean;
  }
  return out;
}
export function normalizeCoworkRecords(records, source = {}) {
  const conversations = new Map();
  for (const record of records) {
    const o = record.object;
    if (!o || typeof o.conversationUuid !== 'string' || !/^cowork:cse_[A-Za-z0-9_-]+$/.test(o.conversationUuid)) continue;
    const isTree = o.product === 'cowork' && o.tree && o.tree.kind === 'cowork_remote';
    if (!isTree && o.tombstone !== true) continue;
    const prev = conversations.get(o.conversationUuid);
    if (!prev || record.sequence > prev.sequence) conversations.set(o.conversationUuid, record);
  }
  const out = [];
  for (const record of conversations.values()) {
    const o = record.object; if (o.tombstone === true) continue;
    if (!Array.isArray(o.tree.events) || o.tree.events.length > 100000) throw Error('Invalid Cowork events');
    const engines = new Map(), spans = new Map(), assistantIds = new Set(), toolIds = new Set(), seenEvents = new Set();
    let first = null, last = null;
    for (const event of o.tree.events) {
      if (!event || !event.payload || !Number.isSafeInteger(event.seq)) continue;
      if (seenEvents.has(event.seq)) continue; seenEvents.add(event.seq);
      const p = event.payload;
      const time = iso(p.created_at || event.created_at || event.timestamp || event.serverCreatedAt);
      if (time) { if (!first || time < first) first = time; if (!last || time > last) last = time; }
      let span = null;
      if (UUID.test(p.session_id || '')) {
        if (!spans.has(p.session_id)) spans.set(p.session_id, {first: null, last: null, assistantIds: new Set(), toolIds: new Set()});
        span = spans.get(p.session_id);
        if (time) { if (!span.first || time < span.first) span.first = time; if (!span.last || time > span.last) span.last = time; }
      }
      if (p.type === 'assistant' && p.message) {
        if (typeof p.message.id === 'string') { assistantIds.add(p.message.id); if (span) span.assistantIds.add(p.message.id); }
        if (Array.isArray(p.message.content)) for (const block of p.message.content) if (block && block.type === 'tool_use' && typeof block.id === 'string') { toolIds.add(block.id); if (span) span.toolIds.add(block.id); }
      }
      if (p.type !== 'result' || !UUID.test(p.session_id || '')) continue;
      if (!p.modelUsage || !nonnegative(p.total_cost_usd)) throw Error('Invalid Cowork cumulative usage or cost');
      const prev = engines.get(p.session_id);
      if (!prev || event.seq > prev.seq) engines.set(p.session_id, {seq: event.seq, payload: p});
    }
    for (const [sessionId, result] of engines) {
      const p = result.payload, usage = safeUsage(p.modelUsage); if (Object.keys(usage).length === 0) continue;
      const span = engines.size > 1 ? spans.get(sessionId) : {first, last, assistantIds, toolIds};
      if (!span.first || !span.last) throw Error('Missing Cowork session timestamp');
      out.push({ sessionId, conversationId: o.conversationUuid, source: 'claude-cowork', sessionName: 'Cowork',
        mtimeMs: Date.parse(span.last), size: source.size || 0,
        costState: {type: 'cost-state', sessionId, totalCostUSD: p.total_cost_usd, modelUsage: usage, hasUnknownModelCost: false},
        shell: {startedAt: span.first, endedAt: span.last, cwd: null}, messageCount: span.assistantIds.size, toolCallCount: span.toolIds.size,
        coverage: {source: 'desktop-cache', completeHistory: false, eventCount: o.tree.events.length, resultSequence: result.seq},
      });
    }
  }
  return out;
}
function fingerprint(stat) { return [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(':'); }
function readDatabase(dir) {
  const reads = new Map(); let total = 0, mtimeMs = 0;
  function read(name) {
    const file = path.join(dir, name), before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) throw Error('Unsupported cache file');
    if (before.size > MAX_FILE_BYTES || (total += before.size) > MAX_TOTAL_BYTES) throw Error('Cowork cache size limit');
    const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
    if (fingerprint(before) !== fingerprint(after) || bytes.length !== after.size) throw Error('Cowork cache changed during read');
    reads.set(file, fingerprint(after)); mtimeMs = Math.max(mtimeMs, after.mtimeMs); return bytes;
  }
  const current = read('CURRENT').toString('utf8').trim(); if (!/^MANIFEST-[0-9]+$/.test(current)) throw Error('Unsupported CURRENT manifest');
  const manifest = decodeManifest(read(current)), state = new Map(), tableBudget = {remaining: MAX_TOTAL_BYTES};
  const names = fs.readdirSync(dir); if (names.length > 10000) throw Error('Cowork cache file limit');
  for (const number of manifest.tables) {
    const base = String(number).padStart(6, '0'); const name = names.includes(base + '.ldb') ? base + '.ldb' : base + '.sst';
    for (const entry of decodeTable(read(name), tableBudget)) mergeEntry(state, entry);
  }
  const logs = names.filter(name => /^[0-9]+\.log$/.test(name) && (Number(name.slice(0, -4)) >= manifest.logNumber || Number(name.slice(0, -4)) === manifest.previousLogNumber));
  replayWal(logs.map(read), state);
  const objects = [], decodeBudget = {remaining: 32 * 1024 * 1024};
  for (const entry of state.values()) {
    if (entry.value === null) continue;
    const conversationId = coworkPrimaryKey(entry.key); if (!conversationId) continue;
    const object = decodeIndexedValue(entry.value, decodeBudget);
    if (!object || object.conversationUuid !== conversationId) throw Error('Cowork key/value mismatch');
    objects.push({object, sequence: entry.sequence});
  }
  for (const [file, signature] of reads) if (fingerprint(fs.lstatSync(file)) !== signature) throw Error('Cowork cache changed during scan');
  if (fs.readdirSync(dir).filter(name => /^[0-9]+\.log$/.test(name)).join('|') !== names.filter(name => /^[0-9]+\.log$/.test(name)).join('|')) throw Error('Cowork log set changed during scan');
  return normalizeCoworkRecords(objects, {mtimeMs, size: total});
}
export function scanCoworkCache(options = {}) {
  const roots = options.roots || discoverCoworkRoots(options), sessions = new Map(), warnings = [];
  for (const root of roots) {
    const dir = path.join(root, 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb'); if (!fs.existsSync(dir)) continue;
    try {
      for (const session of readDatabase(dir)) {
        const prev = sessions.get(session.sessionId);
        if (!prev || session.coverage.resultSequence > prev.coverage.resultSequence) sessions.set(session.sessionId, session);
      }
    } catch (error) {
      const busy = error.code === 'ENOENT' || /^Truncated WAL (?:header|fragment|record)$/.test(error.message) || /^Cowork (?:cache|log set) changed during /.test(error.message);
      warnings.push({source: 'claude-cowork', code: busy ? 'COWORK_CACHE_BUSY' : 'COWORK_CACHE_UNAVAILABLE', retryable: busy,
        message: busy ? 'Cowork cache is being updated; retry after the write completes.' : 'Cowork cache could not be read safely: ' + error.message});
    }
  }
  return { sessions: Array.from(sessions.values()), warnings };
}

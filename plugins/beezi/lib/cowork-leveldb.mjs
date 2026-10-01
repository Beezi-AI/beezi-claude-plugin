// Bounded, read-only LevelDB/Chromium plain-data reader. Unknown formats fail closed.
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ITEMS = 500000;
class Reader {
  constructor(bytes) { this.b = bytes; this.p = 0; }
  take(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_BYTES || this.p + n > this.b.length) throw Error('Truncated or oversized data');
    const b = this.b.subarray(this.p, this.p + n); this.p += n; return b;
  }
  byte() { return this.take(1)[0]; }
  uint() {
    let n = 0, mul = 1;
    for (let i = 0; i < 8; i++) { const c = this.byte(); n += (c & 127) * mul; if (!Number.isSafeInteger(n)) break; if (!(c & 128)) return n; mul *= 128; }
    throw Error('Unsupported varint');
  }
  string() { return this.take(this.uint()); }
}
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0x82f63b78 : 0); crcTable[i] = c; }
function checksum(bytes) { let c = 0xffffffff; for (const x of bytes) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); c = (~c) >>> 0; return (((c >>> 15) | (c << 17)) + 0xa282ead8) >>> 0; }
function check(bytes, expected) { if (checksum(bytes) !== expected) throw Error('LevelDB checksum mismatch'); }

export function walRecords(bytes) {
  if (bytes.length > MAX_BYTES) throw Error('WAL size limit');
  const out = []; let fragments = null, length = 0;
  for (let base = 0; base < bytes.length; base += 32768) {
    const end = Math.min(base + 32768, bytes.length); let p = base;
    while (p < end) {
      if (end - p < 7) { if (bytes.subarray(p, end).some(x => x !== 0)) throw Error('Truncated WAL header'); break; }
      const size = bytes.readUInt16LE(p + 4), type = bytes[p + 6];
      if (size === 0 && type === 0) { if (bytes.subarray(p, end).some(x => x !== 0)) throw Error('Invalid WAL padding'); break; }
      if (p + 7 + size > end) throw Error('Truncated WAL fragment');
      check(bytes.subarray(p + 6, p + 7 + size), bytes.readUInt32LE(p));
      const data = bytes.subarray(p + 7, p + 7 + size);
      if (type === 1 && fragments === null) out.push(data);
      else if (type === 2 && fragments === null) { fragments = [data]; length = data.length; }
      else if ((type === 3 || type === 4) && fragments !== null) {
        fragments.push(data); length += data.length; if (length > MAX_BYTES) throw Error('WAL record size limit');
        if (type === 4) { out.push(Buffer.concat(fragments, length)); fragments = null; }
      } else throw Error('Invalid WAL fragment order');
      if (out.length > MAX_ITEMS) throw Error('WAL record limit');
      p += 7 + size;
    }
  }
  if (fragments !== null) throw Error('Truncated WAL record');
  return out;
}
export function mergeEntry(state, entry) {
  const key = entry.key.toString('hex'), prev = state.get(key);
  if (!prev || entry.sequence > prev.sequence) state.set(key, entry);
  else if (entry.sequence === prev.sequence && (entry.value === null !== (prev.value === null) || (entry.value !== null && !entry.value.equals(prev.value)))) throw Error('Conflicting LevelDB sequence');
  if (state.size > MAX_ITEMS) throw Error('LevelDB key limit');
}
export function replayWal(buffers, state = new Map()) {
  for (const bytes of buffers) for (const record of walRecords(bytes)) {
    const r = new Reader(record); const head = r.take(12), sequence = head.readBigUInt64LE(0), count = head.readUInt32LE(8);
    if (count > MAX_ITEMS) throw Error('Write batch limit');
    for (let i = 0; i < count; i++) {
      const type = r.byte(); if (type !== 0 && type !== 1) throw Error('Unsupported WriteBatch type');
      mergeEntry(state, { key: r.string(), value: type === 1 ? r.string() : null, sequence: sequence + BigInt(i) });
    }
    if (r.p !== record.length) throw Error('Invalid WriteBatch length');
  }
  return state;
}
export function unsnappy(bytes) {
  const r = new Reader(bytes), size = r.uint(); if (size > MAX_BYTES) throw Error('Snappy size limit');
  const out = Buffer.alloc(size); let p = 0;
  while (p < size) {
    const tag = r.byte(), type = tag & 3; let length, offset;
    if (type === 0) {
      length = tag >>> 2;
      if (length < 60) length++;
      else { const width = length - 59; length = 0; const raw = r.take(width); for (let i = 0; i < width; i++) length += raw[i] * Math.pow(256, i); length++; }
      if (p + length > size) throw Error('Snappy literal overrun'); r.take(length).copy(out, p); p += length;
    } else {
      if (type === 1) { length = 4 + ((tag >>> 2) & 7); offset = ((tag & 224) << 3) | r.byte(); }
      else { length = 1 + (tag >>> 2); const raw = r.take(type === 2 ? 2 : 4); offset = type === 2 ? raw.readUInt16LE(0) : raw.readUInt32LE(0); }
      if (offset < 1 || offset > p || p + length > size) throw Error('Snappy copy overrun');
      for (let i = 0; i < length; i++, p++) out[p] = out[p - offset];
    }
  }
  if (r.p !== bytes.length) throw Error('Snappy trailing bytes'); return out;
}

function entries(bytes) {
  if (bytes.length < 4) throw Error('Truncated table block');
  const count = bytes.readUInt32LE(bytes.length - 4), end = bytes.length - 4 - count * 4;
  if (count < 1 || end < 0 || count > MAX_ITEMS) throw Error('Invalid restart array');
  let previousRestart = -1;
  for (let i = 0; i < count; i++) { const n = bytes.readUInt32LE(end + i * 4); if (n < previousRestart || n > end) throw Error('Invalid restart offset'); previousRestart = n; }
  const r = new Reader(bytes.subarray(0, end)), out = []; let previous = Buffer.alloc(0);
  while (r.p < end) {
    const shared = r.uint(), unshared = r.uint(), size = r.uint();
    if (shared > previous.length) throw Error('Invalid shared key prefix');
    const key = Buffer.concat([previous.subarray(0, shared), r.take(unshared)]), value = r.take(size); out.push({ key, value }); previous = key;
    if (out.length > MAX_ITEMS) throw Error('Table entry limit');
  }
  return out;
}
function tableBlock(bytes, handle, budget) {
  const offset = handle.uint(), size = handle.uint();
  if (size > MAX_BYTES || offset + size + 5 > bytes.length - 48) throw Error('Invalid table block handle');
  const block = bytes.subarray(offset, offset + size), type = bytes[offset + size];
  check(bytes.subarray(offset, offset + size + 1), bytes.readUInt32LE(offset + size + 1));
  const decodedLength = type === 1 ? new Reader(block).uint() : block.length;
  if (decodedLength > budget.remaining) throw Error('Table decoded byte budget limit');
  budget.remaining -= decodedLength;
  if (type === 0) return block;
  if (type === 1) return unsnappy(block);
  throw Error('Unsupported table compression');
}
export function decodeTable(bytes, budget = {remaining: MAX_BYTES}) {
  if (bytes.length < 48 || bytes.length > MAX_BYTES || bytes.subarray(bytes.length - 8).toString('hex') !== '57fb808b247547db') throw Error('Unsupported table footer');
  const footer = new Reader(bytes.subarray(bytes.length - 48, bytes.length - 8)); footer.uint(); footer.uint();
  const index = tableBlock(bytes, footer, budget), out = [];
  for (const entry of entries(index)) for (const item of entries(tableBlock(bytes, new Reader(entry.value), budget))) {
    if (item.key.length < 8) throw Error('Invalid internal key');
    const packed = item.key.readBigUInt64LE(item.key.length - 8), type = Number(packed & 255n);
    if (type !== 0 && type !== 1) throw Error('Unsupported internal key type');
    out.push({key: item.key.subarray(0, item.key.length - 8), sequence: packed >> 8n, value: type === 0 ? null : item.value});
    if (out.length > MAX_ITEMS) throw Error('Table entry limit');
  }
  return out;
}
export function decodeManifest(bytes) {
  const live = new Map(); let logNumber = 0, previousLogNumber = 0;
  for (const record of walRecords(bytes)) {
    const r = new Reader(record);
    while (r.p < record.length) {
      const tag = r.uint();
      if (tag === 1) { if (!['leveldb.BytewiseComparator', 'idb_cmp1'].includes(r.string().toString())) throw Error('Unsupported LevelDB comparator'); }
      else if (tag === 2) logNumber = r.uint();
      else if (tag === 9) previousLogNumber = r.uint();
      else if (tag === 3 || tag === 4) r.uint();
      else if (tag === 5) { r.uint(); r.string(); }
      else if (tag === 6) { const level = r.uint(), number = r.uint(); live.delete(level + ':' + number); }
      else if (tag === 7) { const level = r.uint(), number = r.uint(); r.uint(); r.string(); r.string(); live.set(level + ':' + number, number); }
      else throw Error('Unsupported manifest tag');
    }
  }
  return { tables: new Set(live.values()), logNumber, previousLogNumber };
}

// Chromium uses Blink framing around V8. Only plain data wire tags are accepted;
// host objects, typed buffers, external blob references and future versions are rejected.
export function decodeIndexedValue(bytes, budget = {remaining: MAX_BYTES}) {
  const prefix = new Reader(bytes); prefix.uint(); let data = bytes.subarray(prefix.p);
  if (data[0] !== 255) return null; // IndexedDB schema/index records, not values.
  const compressed = data[1] === 17 && data[2] === 2;
  const decodedLength = compressed ? new Reader(data.subarray(3)).uint() : data.length;
  if (decodedLength > budget.remaining) throw Error('Decoded byte budget limit');
  budget.remaining -= decodedLength;
  if (compressed) data = unsnappy(data.subarray(3));
  let r = new Reader(data);
  if (r.byte() !== 255) throw Error('Invalid serialization header'); let version = r.uint();
  if (version >= 18 && version <= 21) {
    if (version >= 21) { if (r.byte() !== 254) throw Error('Unsupported Blink header'); const trailer = r.take(12); if (trailer.some(x => x !== 0)) throw Error('Unsupported Blink trailer'); }
    if (r.byte() !== 255) throw Error('Invalid V8 header'); version = r.uint();
  }
  if (version !== 15 && version !== 16) throw Error('Unsupported V8 version');
  const refs = []; let nodes = 0;
  function read(depth) {
    if (depth > 128 || ++nodes > MAX_ITEMS) throw Error('V8 structure limit');
    let tag = r.byte(); while (tag === 0) tag = r.byte();
    if (tag === 95 || tag === 45) return undefined;
    if (tag === 48) return null;
    if (tag === 84 || tag === 70) return tag === 84;
    if (tag === 73) { const n = r.uint(); return (n >>> 1) ^ -(n & 1); }
    if (tag === 85) return r.uint();
    if (tag === 78) return r.take(8).readDoubleLE(0);
    if (tag === 34 || tag === 83 || tag === 99) { const b = r.string(); if (tag === 99 && b.length % 2) throw Error('Invalid UTF16 length'); return b.toString(tag === 34 ? 'latin1' : tag === 83 ? 'utf8' : 'utf16le'); }
    if (tag === 94) { const id = r.uint(); if (id >= refs.length) throw Error('Invalid V8 reference'); return refs[id]; }
    if (tag !== 111 && tag !== 65 && tag !== 97) throw Error('Unsupported V8 tag ' + tag);
    const array = tag !== 111, length = array ? r.uint() : 0;
    if (length > MAX_ITEMS) throw Error('V8 array limit');
    const o = array ? [] : {}; refs.push(o);
    if (tag === 65) for (let i = 0; i < length; i++) o.push(read(depth + 1));
    const endTag = tag === 111 ? 123 : tag === 65 ? 36 : 64; let props = 0;
    while (r.b[r.p] !== endTag) {
      const key = read(depth + 1); if (typeof key !== 'string' && typeof key !== 'number') throw Error('Invalid V8 key');
      Object.defineProperty(o, key, {value: read(depth + 1), enumerable: true, configurable: true, writable: true}); props++;
    }
    r.byte(); if (r.uint() !== props) throw Error('V8 property count mismatch');
    if (array) { if (r.uint() !== length) throw Error('V8 array length mismatch'); o.length = length; }
    return o;
  }
  const object = read(0); if (r.p !== data.length) throw Error('Unsupported trailing V8 data'); return object;
}

export function coworkPrimaryKey(bytes) {
  const r = new Reader(bytes), prefix = r.byte();
  const widths = [(prefix >>> 5) + 1, ((prefix >>> 2) & 7) + 1, (prefix & 3) + 1];
  const ids = widths.map(width => { let n = 0; const b = r.take(width); for (let i = 0; i < width; i++) n += b[i] * Math.pow(256, i); return n; });
  if (ids[0] === 0 || ids[1] === 0 || ids[2] !== 1 || r.byte() !== 1) return null;
  const chars = r.uint(); if (chars > 200) return null;
  const utf = Buffer.from(r.take(chars * 2)); utf.swap16(); const name = utf.toString('utf16le');
  if (r.p !== bytes.length) return null;
  return /^cowork:cse_[A-Za-z0-9_-]+$/.test(name) ? name : null;
}

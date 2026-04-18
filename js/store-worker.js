// ══════════════════════════════════════════════════════════════════════
// store-worker.js — OPFS-backed binary store (runs as a Worker)
//
// Owns the only SyncAccessHandle on the collection's .eodb file. Events
// are packed into fixed 32-byte records held in a growable Uint8Array;
// variable-length fields (clause, spo, operand, rationale, provenance)
// live in a body block, referenced by 4-byte offsets from the packed
// record. Anchors, edges, rules, frames, and metrics are held in
// normal JS structures and flushed as a JSON side-section.
//
// Wire format (fixed 256-byte header at offset 0):
//   0..3    magic           "EODB"
//   4..5    version         u16 LE (=1)
//   6..7    flags           u16 LE
//   8..11   events_count    u32 LE
//  12..15   events_offset   u32 LE
//  16..19   body_length     u32 LE
//  20..23   body_offset     u32 LE
//  24..27   side_length     u32 LE
//  28..31   side_offset     u32 LE
//  32..255  reserved
//
// Packed event record (32 bytes):
//    0    1  op_code              u8    (1..9)
//    1    1  site<<4 | resolution u8    (high nibble = site, low = res)
//    2    6  timestamp_ms         u48 LE
//    8    8  target_hash          two u32 LE (64-bit)
//   16    4  body_offset          u32 LE
//   20    2  body_length          u16 LE
//   22    2  agent_code           u16 LE
//   24    4  frame_fingerprint    u32 LE
//   28    1  confidence_u8        u8  (0..255, quantized from 0..1)
//   29    1  object_code          u8  (0=Condition, 1=Entity, 2=Pattern)
//   30    1  flags                u8
//   31    1  reserved             u8
//
// Body block: length-prefixed JSON records [u32 length][utf8 bytes].
// ══════════════════════════════════════════════════════════════════════

/* ═══ Constants & state ════════════════════════════════════════════════ */

const MAGIC = new Uint8Array([0x45, 0x4f, 0x44, 0x42]); // "EODB"
const VERSION = 1;
const HEADER_SIZE = 256;
const EVENT_SIZE = 32;
const OBJECT_CODES = { Condition: 0, Entity: 1, Pattern: 2 };
const AGENT_CORE = { unknown:0, user:1, heuristic:2, model:3, rule:4, seed:5, sync:6, 'user-rec':7 };

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

/** The single SyncAccessHandle on the .eodb file. */
let handle = null;
let fileName = 'default.eodb';

/** Events: packed bytes + count. */
let eventsBuf = new Uint8Array(0);   // packed record array, capacity may exceed used
let eventsCount = 0;

/** Variable-length fields per event. */
let bodyBuf = new Uint8Array(0);
let bodyLen = 0;

/** Side structures (flushed as JSON). */
let anchors = new Map();   // hash -> {hash, form, original, type_hint, first_seen}
let edges = [];            // [{source, target, relation, event}]
let rules = [];
let frames = new Map();
let metrics = defaultMetrics();
let agentStringTable = [...Object.keys(AGENT_CORE)]; // index → string

/** Dirty flag: in-memory state has changed since last flush. */
let dirty = false;
let flushTimer = null;
const FLUSH_INTERVAL_MS = 3000;

/* ═══ Worker protocol ══════════════════════════════════════════════════ */

self.onmessage = async ({ data }) => {
  const { id, method, args } = data;
  try {
    const result = await dispatch(method, args);
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: { message: e.message || String(e), stack: e.stack } });
  }
};

async function dispatch(method, args) {
  switch (method) {
    case 'open':             return openFile(args?.name);
    case 'close':            return closeFile();
    case 'flush':            return flushIfDirty(true);
    case 'appendEvent':      return appendEvent(args);
    case 'appendEvents':     return appendEvents(args);
    case 'getEvents':        return queryEvents(args || {});
    case 'countEvents':      return countEvents(args || {});
    case 'getRecentEvents':  return recentEvents(args?.limit || 50);
    case 'getAnchor':        return anchors.get(args?.hash) || null;
    case 'upsertAnchor':     return upsertAnchor(args);
    case 'getAllAnchors':    return [...anchors.values()];
    case 'appendEdge':       return appendEdge(args);
    case 'getEdgesFrom':     return edges.filter(e => e.source === args?.source);
    case 'getEdgesTo':       return edges.filter(e => e.target === args?.target);
    case 'getFrame':         return frames.get(args?.hash) || null;
    case 'upsertFrame':      return upsertFrame(args);
    case 'getAllRules':      return rules.slice();
    case 'appendRule':       return appendRule(args);
    case 'deactivateRule':   return deactivateRule(args?.id);
    case 'getMetrics':       return { ...metrics };
    case 'updateMetrics':    return updateMetrics(args || {});
    case 'resetMetrics':     return resetMetricsNow();
    case 'clearAll':         return clearAll();
    case 'storageEstimate':  return estimate();
    case 'exportFile':       return exportFile();
    case 'importFile':       return importFile(args?.bytes);
    default: throw new Error(`unknown method: ${method}`);
  }
}

/* ═══ OPFS lifecycle ═══════════════════════════════════════════════════ */

async function openFile(name) {
  if (name) fileName = name;
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(fileName, { create: true });
  handle = await fh.createSyncAccessHandle();
  const size = handle.getSize();
  if (size >= HEADER_SIZE) {
    loadFromFile(size);
  } else {
    initEmpty();
  }
  scheduleFlush();
  return { opened: true, name: fileName, size, events: eventsCount };
}

async function closeFile() {
  if (!handle) return { closed: true };
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushIfDirty(true);
  handle.close();
  handle = null;
  return { closed: true };
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try { flushIfDirty(false); } catch(e) { /* swallow */ }
    scheduleFlush();
  }, FLUSH_INTERVAL_MS);
}

/* ═══ File load / flush ════════════════════════════════════════════════ */

function initEmpty() {
  eventsBuf = new Uint8Array(256 * EVENT_SIZE);
  eventsCount = 0;
  bodyBuf = new Uint8Array(4096);
  bodyLen = 0;
  anchors = new Map();
  edges = [];
  rules = [];
  frames = new Map();
  metrics = defaultMetrics();
  agentStringTable = [...Object.keys(AGENT_CORE)];
  dirty = true;
}

function loadFromFile(size) {
  const header = new Uint8Array(HEADER_SIZE);
  handle.read(header, { at: 0 });
  for (let i = 0; i < 4; i++) {
    if (header[i] !== MAGIC[i]) { initEmpty(); return; }
  }
  const hv = new DataView(header.buffer);
  const version = hv.getUint16(4, true);
  if (version > VERSION) { initEmpty(); return; }

  const ec  = hv.getUint32(8, true);
  const eo  = hv.getUint32(12, true);
  const bl  = hv.getUint32(16, true);
  const bo  = hv.getUint32(20, true);
  const sl  = hv.getUint32(24, true);
  const so  = hv.getUint32(28, true);

  // Events section
  eventsCount = ec;
  const eventsCap = Math.max(256 * EVENT_SIZE, ec * EVENT_SIZE);
  eventsBuf = new Uint8Array(eventsCap);
  if (ec > 0) {
    const target = new Uint8Array(eventsBuf.buffer, 0, ec * EVENT_SIZE);
    handle.read(target, { at: eo });
  }

  // Body section
  bodyLen = bl;
  bodyBuf = new Uint8Array(Math.max(4096, bl));
  if (bl > 0) {
    const target = new Uint8Array(bodyBuf.buffer, 0, bl);
    handle.read(target, { at: bo });
  }

  // Side section (JSON)
  if (sl > 0) {
    const sideBytes = new Uint8Array(sl);
    handle.read(sideBytes, { at: so });
    try {
      const side = JSON.parse(textDec.decode(sideBytes));
      anchors = new Map(side.anchors || []);
      edges = side.edges || [];
      rules = side.rules || [];
      frames = new Map(side.frames || []);
      metrics = side.metrics || defaultMetrics();
      agentStringTable = side.agentTable || [...Object.keys(AGENT_CORE)];
    } catch (e) {
      // Corrupt side section — reset side, keep events/body
      anchors = new Map(); edges = []; rules = []; frames = new Map();
      metrics = defaultMetrics();
      agentStringTable = [...Object.keys(AGENT_CORE)];
      dirty = true;
    }
  } else {
    agentStringTable = [...Object.keys(AGENT_CORE)];
  }
}

function flushIfDirty(force) {
  if (!handle) return { flushed: false, reason: 'no-handle' };
  if (!dirty && !force) return { flushed: false, reason: 'clean' };

  const sideJson = JSON.stringify({
    anchors: [...anchors.entries()],
    edges,
    rules,
    frames: [...frames.entries()],
    metrics,
    agentTable: agentStringTable
  });
  const sideBytes = textEnc.encode(sideJson);

  const eventsBytes = eventsCount * EVENT_SIZE;
  const bodyBytes = bodyLen;
  const sideBytesLen = sideBytes.length;

  // Layout: [header 256][events][body][side]
  const eventsOffset = HEADER_SIZE;
  const bodyOffset = eventsOffset + eventsBytes;
  const sideOffset = bodyOffset + bodyBytes;
  const totalSize = sideOffset + sideBytesLen;

  // Write header
  const header = new Uint8Array(HEADER_SIZE);
  header.set(MAGIC, 0);
  const hv = new DataView(header.buffer);
  hv.setUint16(4, VERSION, true);
  hv.setUint16(6, 0, true);
  hv.setUint32(8, eventsCount, true);
  hv.setUint32(12, eventsOffset, true);
  hv.setUint32(16, bodyBytes, true);
  hv.setUint32(20, bodyOffset, true);
  hv.setUint32(24, sideBytesLen, true);
  hv.setUint32(28, sideOffset, true);

  handle.truncate(totalSize);
  handle.write(header, { at: 0 });
  if (eventsBytes > 0) {
    handle.write(new Uint8Array(eventsBuf.buffer, 0, eventsBytes), { at: eventsOffset });
  }
  if (bodyBytes > 0) {
    handle.write(new Uint8Array(bodyBuf.buffer, 0, bodyBytes), { at: bodyOffset });
  }
  if (sideBytesLen > 0) {
    handle.write(sideBytes, { at: sideOffset });
  }
  handle.flush();
  dirty = false;
  return { flushed: true, bytes: totalSize, events: eventsCount };
}

/* ═══ Event encode / decode ════════════════════════════════════════════ */

function ensureEventsCapacity() {
  const needed = (eventsCount + 1) * EVENT_SIZE;
  if (needed <= eventsBuf.length) return;
  const newSize = Math.max(eventsBuf.length * 2, needed);
  const newBuf = new Uint8Array(newSize);
  newBuf.set(eventsBuf);
  eventsBuf = newBuf;
}

function ensureBodyCapacity(extra) {
  const needed = bodyLen + extra;
  if (needed <= bodyBuf.length) return;
  const newSize = Math.max(bodyBuf.length * 2, needed + 4096);
  const newBuf = new Uint8Array(newSize);
  newBuf.set(bodyBuf);
  bodyBuf = newBuf;
}

function writeBody(obj) {
  const bytes = textEnc.encode(JSON.stringify(obj));
  const len = bytes.length;
  ensureBodyCapacity(4 + len);
  const view = new DataView(bodyBuf.buffer, bodyLen);
  view.setUint32(0, len, true);
  bodyBuf.set(bytes, bodyLen + 4);
  const offset = bodyLen;
  bodyLen += 4 + len;
  return { offset, length: len };
}

function readBody(offset) {
  if (offset < 0 || offset + 4 > bodyLen) return null;
  const view = new DataView(bodyBuf.buffer, offset);
  const len = view.getUint32(0, true);
  if (offset + 4 + len > bodyLen) return null;
  const bytes = new Uint8Array(bodyBuf.buffer, offset + 4, len);
  try { return JSON.parse(textDec.decode(bytes)); } catch(e) { return null; }
}

function agentCode(name) {
  if (name == null) return 0;
  const existing = agentStringTable.indexOf(name);
  if (existing >= 0) return existing;
  agentStringTable.push(name);
  return agentStringTable.length - 1;
}
function agentName(code) { return agentStringTable[code] || 'unknown'; }

function frameFingerprint(frame) {
  // cyrb-style 32-bit hash on the frame name
  const s = String(frame || 'default');
  let h1 = 0xdeadbeef | 0;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 2654435761);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  return h1 >>> 0;
}

function hashU64(hexStr) {
  const s = String(hexStr || '').padEnd(16, '0').slice(0, 16);
  return {
    lo: (parseInt(s.slice(0, 8), 16) >>> 0) || 0,
    hi: (parseInt(s.slice(8, 16), 16) >>> 0) || 0
  };
}

function packEvent(ev) {
  // Body block holds the fields we don't use for hot-path filtering
  const bodyRec = {
    clause: ev.clause,
    spo: ev.spo,
    operand: ev.operand,
    rationale: ev.rationale,
    agent: ev.agent,
    uuid: ev.uuid,
    target_form: ev.target_form,
    provenance: ev.provenance,
    mode: ev.mode,
    domain: ev.domain,
    object: ev.object,
    site_name: ev.site_name,
    resolution_name: ev.resolution_name,
    operator: ev.operator,
    ts: ev.ts,
    frame: ev.frame
  };
  const { offset: bOff, length: bLen } = writeBody(bodyRec);

  ensureEventsCapacity();
  const off = eventsCount * EVENT_SIZE;
  const view = new DataView(eventsBuf.buffer, off, EVENT_SIZE);

  view.setUint8(0, ev.op_code || 0);
  view.setUint8(1, (((ev.site || 0) & 0xf) << 4) | ((ev.resolution || 0) & 0xf));

  const ts = Date.parse(ev.ts) || Date.now();
  view.setUint32(2, ts >>> 0, true);
  view.setUint16(6, Math.floor(ts / 0x100000000) & 0xffff, true);

  const { lo, hi } = hashU64(ev.target);
  view.setUint32(8, lo, true);
  view.setUint32(12, hi, true);

  view.setUint32(16, bOff, true);
  view.setUint16(20, bLen, true);

  view.setUint16(22, agentCode(ev.agent) & 0xffff, true);
  view.setUint32(24, frameFingerprint(ev.frame), true);
  view.setUint8(28, Math.min(255, Math.max(0, Math.round((ev.confidence || 0) * 255))));
  view.setUint8(29, OBJECT_CODES[ev.object] ?? 0);
  view.setUint8(30, ev._flags || 0);
  view.setUint8(31, 0);

  eventsCount++;
  dirty = true;
}

function decodeEventAt(index) {
  const off = index * EVENT_SIZE;
  const view = new DataView(eventsBuf.buffer, off, EVENT_SIZE);
  const op_code = view.getUint8(0);
  const sr = view.getUint8(1);
  const site = (sr >> 4) & 0xf;
  const resolution = sr & 0xf;
  const tsLo = view.getUint32(2, true);
  const tsHi = view.getUint16(6, true);
  const ts_ms = tsHi * 0x100000000 + tsLo;
  const hashLo = view.getUint32(8, true);
  const hashHi = view.getUint32(12, true);
  const target = hashLo.toString(16).padStart(8, '0') + hashHi.toString(16).padStart(8, '0');
  const bOff = view.getUint32(16, true);
  const bLen = view.getUint16(20, true);
  const agentIdx = view.getUint16(22, true);
  const framePrint = view.getUint32(24, true);
  const conf = view.getUint8(28) / 255;
  const objCode = view.getUint8(29);

  const body = readBody(bOff) || {};
  return {
    op_code,
    operator: body.operator,
    site,
    site_name: body.site_name,
    resolution,
    resolution_name: body.resolution_name,
    ts: body.ts || new Date(ts_ms).toISOString(),
    ts_ms,
    target,
    target_form: body.target_form,
    operand: body.operand,
    spo: body.spo,
    mode: body.mode,
    domain: body.domain,
    object: body.object ?? Object.keys(OBJECT_CODES)[objCode],
    frame: body.frame || 'default',
    frame_fingerprint: framePrint,
    agent: body.agent || agentName(agentIdx),
    uuid: body.uuid,
    clause: body.clause,
    rationale: body.rationale,
    confidence: +conf.toFixed(3),
    provenance: body.provenance
  };
}

/* ═══ Event API ════════════════════════════════════════════════════════ */

function appendEvent(ev) {
  packEvent(ev);
  return ev;
}
function appendEvents(list) {
  for (const ev of list || []) packEvent(ev);
  return list?.length || 0;
}

/**
 * Query events by filter. This is the hot path — we scan the packed
 * events buffer byte-by-byte for the indexed fields, only decoding the
 * full body record when a packed-level match is found.
 */
function queryEvents(filter) {
  const limit = filter.limit ?? 500;
  const fromTs = filter.from ? Date.parse(filter.from) : null;
  const toTs   = filter.to   ? Date.parse(filter.to)   : null;
  const frameFp = filter.frame ? frameFingerprint(filter.frame) : null;
  const targetHash = filter.target ? hashU64(filter.target) : null;
  const op_code = filter.op_code ?? null;
  const site = filter.site ?? null;
  const resolution = filter.resolution ?? null;
  const object = filter.object != null ? (OBJECT_CODES[filter.object] ?? null) : null;

  const view = new DataView(eventsBuf.buffer, 0, eventsCount * EVENT_SIZE);
  const results = [];

  for (let i = 0; i < eventsCount; i++) {
    const off = i * EVENT_SIZE;
    // Fast bail-outs in rough order of commonality
    if (op_code != null && view.getUint8(off) !== op_code) continue;

    if (site != null || resolution != null) {
      const sr = view.getUint8(off + 1);
      if (site != null && ((sr >> 4) & 0xf) !== site) continue;
      if (resolution != null && (sr & 0xf) !== resolution) continue;
    }

    if (fromTs != null || toTs != null) {
      const tsLo = view.getUint32(off + 2, true);
      const tsHi = view.getUint16(off + 6, true);
      const ts_ms = tsHi * 0x100000000 + tsLo;
      if (fromTs != null && ts_ms < fromTs) continue;
      if (toTs != null && ts_ms > toTs) continue;
    }

    if (targetHash) {
      const lo = view.getUint32(off + 8, true);
      const hi = view.getUint32(off + 12, true);
      if (lo !== targetHash.lo || hi !== targetHash.hi) continue;
    }

    if (frameFp != null && view.getUint32(off + 24, true) !== frameFp) continue;

    if (object != null && view.getUint8(off + 29) !== object) continue;

    // Packed match — decode full record
    results.push(decodeEventAt(i));
    if (results.length >= limit) break;
  }

  // Apply text filter after decode (body content is needed)
  if (filter.text) {
    const q = filter.text.toLowerCase();
    return results.filter(e => {
      const hay = `${e.clause||''} ${e.target_form||''} ${e.spo?.s||''} ${e.spo?.p||''} ${e.spo?.o||''} ${e.operand||''}`.toLowerCase();
      return hay.includes(q);
    });
  }
  return results;
}

function countEvents(filter) {
  if (!filter || Object.keys(filter).length === 0) return eventsCount;
  return queryEvents({ ...filter, limit: 1e9 }).length;
}

function recentEvents(limit) {
  // Events are appended in time order, so "recent" = last N records
  const start = Math.max(0, eventsCount - limit);
  const out = [];
  for (let i = eventsCount - 1; i >= start; i--) out.push(decodeEventAt(i));
  return out;
}

/* ═══ Anchors / edges / frames / rules ═════════════════════════════════ */

function upsertAnchor(anchor) {
  const existing = anchors.get(anchor.hash);
  if (existing) return { created: false, anchor: existing };
  anchors.set(anchor.hash, anchor);
  dirty = true;
  return { created: true, anchor };
}

function appendEdge(edge) {
  // Dedupe on [source, target, relation]
  for (const e of edges) {
    if (e.source === edge.source && e.target === edge.target && e.relation === edge.relation) {
      return { created: false, edge: e };
    }
  }
  edges.push(edge);
  dirty = true;
  return { created: true, edge };
}

function upsertFrame(frame) {
  frames.set(frame.hash, frame);
  dirty = true;
  return frame;
}

function appendRule(rule) {
  rules.push(rule);
  dirty = true;
  return rule;
}

function deactivateRule(id) {
  const r = rules.find(x => x.id === id);
  if (r) {
    r.active = false;
    r.deactivated_at = new Date().toISOString();
    dirty = true;
  }
  return r;
}

/* ═══ Metrics ══════════════════════════════════════════════════════════ */

function defaultMetrics() {
  return {
    id: 'session',
    heuristicCalls: 0,
    modelCalls: 0,
    modelTokensIn: 0,
    modelTokensOut: 0,
    horizonQueries: 0,
    nulGates: 0,
    conflictsAdjudicated: 0,
    recProposalsAccepted: 0,
    recProposalsRejected: 0,
    foldWorkerRuns: 0,
    startedAt: new Date().toISOString()
  };
}

function updateMetrics(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'number' && typeof metrics[k] === 'number') {
      metrics[k] += v;
    } else {
      metrics[k] = v;
    }
  }
  dirty = true;
  return { ...metrics };
}

function resetMetricsNow() {
  metrics = defaultMetrics();
  dirty = true;
  return { ...metrics };
}

/* ═══ Admin ════════════════════════════════════════════════════════════ */

function clearAll() {
  initEmpty();
  flushIfDirty(true);
  return { cleared: true };
}

async function estimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage, quota: e.quota, fileSize: handle ? handle.getSize() : 0 };
  } catch(e) { return null; }
}

function exportFile() {
  flushIfDirty(true);
  const size = handle.getSize();
  const buf = new Uint8Array(size);
  handle.read(buf, { at: 0 });
  return { bytes: buf.buffer, name: fileName };
}

function importFile(bytes) {
  if (!bytes) throw new Error('no bytes');
  handle.truncate(bytes.byteLength);
  handle.write(new Uint8Array(bytes), { at: 0 });
  handle.flush();
  loadFromFile(bytes.byteLength);
  return { imported: true, events: eventsCount };
}

/* ═══ Flush on terminate ═══════════════════════════════════════════════ */

self.addEventListener('unload', () => {
  try { flushIfDirty(true); handle?.close(); } catch(e) {}
});

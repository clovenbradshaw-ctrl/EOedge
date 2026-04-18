// ══════════════════════════════════════════════════════════════════════
// store.js — main-thread facade over the OPFS Worker
//
// Preserves the exact API that the rest of the runtime imports against.
// All work happens in store-worker.js; this module is just a typed RPC
// proxy plus a local pub/sub that fires after successful worker calls.
// ══════════════════════════════════════════════════════════════════════

let worker = null;
let nextId = 0;
const pending = new Map();
const subscribers = new Set();
let opened = false;
let openPromise = null;

function startWorker() {
  if (worker) return;
  // URL resolves relative to this module; works regardless of where index.html lives
  worker = new Worker(new URL('./store-worker.js', import.meta.url));
  worker.onmessage = ({ data }) => {
    const { id, result, error } = data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(Object.assign(new Error(error.message), { stack: error.stack }));
    else p.resolve(result);
  };
  worker.onerror = (e) => {
    console.error('store-worker error:', e.message, e);
  };
}

function call(method, args, transfer) {
  startWorker();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args }, transfer || []);
  });
}

/* ═══ Pub/sub (main thread) ════════════════════════════════════════════ */
export function subscribe(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}
function notify(kind, payload) {
  for (const cb of subscribers) {
    try { cb(kind, payload); } catch(e) { console.error(e); }
  }
}

/* ═══ Lifecycle ════════════════════════════════════════════════════════ */
export async function openDB() {
  if (opened) return true;
  if (openPromise) return openPromise;
  openPromise = (async () => {
    startWorker();
    await call('open', { name: 'default.eodb' });
    opened = true;

    // Best-effort flush on page hide / unload
    const flush = () => { try { call('flush', {}); } catch(e) {} };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);

    return true;
  })();
  return openPromise;
}

export async function flush()       { return call('flush', {}); }
export async function exportFile()  { return call('exportFile', {}); }
export async function importFile(bytes) {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
  return call('importFile', { bytes: buf }, [buf]);
}

/* ═══ Events ═══════════════════════════════════════════════════════════ */
export async function appendEvent(event) {
  const r = await call('appendEvent', event);
  notify('event', event);
  return r;
}
export async function appendEvents(events) {
  const r = await call('appendEvents', events);
  for (const ev of events || []) notify('event', ev);
  return r;
}
export async function getEvents(filter = {})      { return call('getEvents', filter); }
export async function countEvents(filter = {})    { return call('countEvents', filter); }
export async function getRecentEvents(limit = 50) { return call('getRecentEvents', { limit }); }

/* ═══ Anchors ══════════════════════════════════════════════════════════ */
export async function getAnchor(hash)      { return call('getAnchor', { hash }); }
export async function upsertAnchor(anchor) {
  const r = await call('upsertAnchor', anchor);
  if (r.created) notify('anchor', r.anchor);
  return r;
}
export async function getAllAnchors()      { return call('getAllAnchors', {}); }

/* ═══ Edges ════════════════════════════════════════════════════════════ */
export async function appendEdge(edge) {
  const r = await call('appendEdge', edge);
  if (r.created) notify('edge', r.edge);
  return r;
}
export async function getEdgesFrom(source) { return call('getEdgesFrom', { source }); }
export async function getEdgesTo(target)   { return call('getEdgesTo',   { target }); }

/* ═══ Frames ═══════════════════════════════════════════════════════════ */
export async function getFrame(hash)    { return call('getFrame', { hash }); }
export async function upsertFrame(frame) {
  const r = await call('upsertFrame', frame);
  notify('frame', r);
  return r;
}

/* ═══ Rules (REC-installed) ════════════════════════════════════════════ */
export async function getAllRules()     { return call('getAllRules', {}); }
export async function appendRule(rule)  {
  const r = await call('appendRule', rule);
  notify('rule', r);
  return r;
}
export async function deactivateRule(id) {
  const r = await call('deactivateRule', { id });
  notify('rule', r);
  return r;
}

/* ═══ Metrics ══════════════════════════════════════════════════════════ */
export async function getMetrics()          { return call('getMetrics', {}); }
export async function updateMetrics(patch)  {
  const r = await call('updateMetrics', patch);
  notify('metrics', r);
  return r;
}
export async function resetMetrics() {
  const r = await call('resetMetrics', {});
  notify('metrics', r);
  return r;
}

/* ═══ Admin ════════════════════════════════════════════════════════════ */
export async function clearAll() {
  const r = await call('clearAll', {});
  notify('reset', null);
  return r;
}
export async function storageEstimate() { return call('storageEstimate', {}); }

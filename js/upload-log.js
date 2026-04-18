// ══════════════════════════════════════════════════════════════════════
// upload-log.js — per-document, append-only processing log
//
// One log per doc_id. Every stage transition (started / progress / done /
// failed / skipped / cached) is a record. The Uploads panel is a
// projection over this log; it never derives state from stage internals.
//
// In-memory only: the durable artifacts the pipeline emits live in OPFS
// (events, anchors, edges); this log is the live telemetry that describes
// how those artifacts were produced. It's rebuilt per session.
// ══════════════════════════════════════════════════════════════════════

import { STAGES, PREREQS, PERSISTS } from './upload-pipeline.js';

const _docs = new Map();          // doc_id → DocLog
const _subs = new Set();          // (doc_id) => void

function notify(doc_id) {
  for (const fn of _subs) {
    try { fn(doc_id); } catch(e) { console.error('upload-log sub error', e); }
  }
}

/** Create a new doc entry. Overwrites if doc_id already exists. */
export function createDoc({ doc_id, name, size, mime, mode = 'eo' }) {
  const stages = {};
  for (const s of STAGES) {
    stages[s] = {
      status: 'pending',
      started_at: null,
      completed_at: null,
      duration_ms: 0,
      input_hash: null,
      artifact: null,
      summary: '',
      error: null,
      persists: PERSISTS[s],
      prereqs: PREREQS[s]
    };
  }
  const entry = {
    doc_id,
    name,
    size_bytes: size,
    mime,
    mode,
    started_at: new Date().toISOString(),
    completed_at: null,
    overall: 'pending', // pending | running | done | failed
    records: [],        // full event stream for this doc
    stages
  };
  _docs.set(doc_id, entry);
  notify(doc_id);
  return entry;
}

/** Append a stage event. Merges into the stage slot; also appends to records. */
export function appendRecord(doc_id, rec) {
  const entry = _docs.get(doc_id);
  if (!entry) return;
  const fullRec = { ...rec, ts: new Date().toISOString() };
  entry.records.push(fullRec);
  const stage = entry.stages[rec.stage];
  if (stage) {
    if (rec.status === 'started') {
      stage.status = 'running';
      stage.started_at = fullRec.ts;
      stage.error = null;
    } else if (rec.status === 'done') {
      stage.status = 'done';
      stage.completed_at = fullRec.ts;
      if (stage.started_at) {
        stage.duration_ms = Date.parse(fullRec.ts) - Date.parse(stage.started_at);
      }
      if (rec.artifact != null) stage.artifact = rec.artifact;
      if (rec.summary) stage.summary = rec.summary;
      if (rec.input_hash) stage.input_hash = rec.input_hash;
    } else if (rec.status === 'cached') {
      stage.status = 'cached';
      stage.completed_at = fullRec.ts;
      stage.started_at = stage.started_at || fullRec.ts;
      stage.duration_ms = 0;
      if (rec.artifact != null) stage.artifact = rec.artifact;
      if (rec.summary) stage.summary = rec.summary;
      if (rec.input_hash) stage.input_hash = rec.input_hash;
    } else if (rec.status === 'failed') {
      stage.status = 'failed';
      stage.completed_at = fullRec.ts;
      stage.error = rec.error || 'unknown';
    } else if (rec.status === 'skipped') {
      stage.status = 'skipped';
      stage.completed_at = fullRec.ts;
      stage.summary = rec.summary || 'skipped';
    }
  }
  if (rec.overall) entry.overall = rec.overall;
  if (rec.overall === 'done' || rec.overall === 'failed') {
    entry.completed_at = fullRec.ts;
  }
  notify(doc_id);
}

export function getDoc(doc_id)    { return _docs.get(doc_id) || null; }
export function listDocs()        { return Array.from(_docs.values()).sort((a,b) => b.started_at.localeCompare(a.started_at)); }
export function hasDocs()         { return _docs.size > 0; }
export function subscribe(fn)     { _subs.add(fn); return () => _subs.delete(fn); }

/** Remove a doc from the live log (does not touch OPFS artifacts). */
export function clearDoc(doc_id) {
  _docs.delete(doc_id);
  notify(doc_id);
}

export function clearAll() {
  _docs.clear();
  notify(null);
}

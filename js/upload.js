// ══════════════════════════════════════════════════════════════════════
// upload.js — document drop zone
//
// Accepts plain text, markdown, CSV, JSON text. For PDFs / DOCX we'd
// integrate pdf.js / mammoth — out of v1 scope but the shape is the same:
// extract text, hand to the intake pipeline.
// ══════════════════════════════════════════════════════════════════════

import { ingest } from './intake.js';

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB safety cap

const EXTRACTORS = {
  'text/plain':       readAsText,
  'text/markdown':    readAsText,
  'text/csv':         readAsText,
  'application/json': readAsJSON,
  'application/x-ndjson': readAsText
};

export async function extractText(file) {
  if (!file) throw new Error('no file');
  if (file.size > MAX_BYTES) throw new Error(`file too large (${file.size} bytes; limit ${MAX_BYTES})`);
  const type = file.type || inferType(file.name);
  const extractor = EXTRACTORS[type] || readAsText;
  return extractor(file);
}

function inferType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['md','markdown','txt','log'].includes(ext)) return 'text/plain';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'json') return 'application/json';
  if (ext === 'ndjson' || ext === 'jsonl') return 'application/x-ndjson';
  return 'text/plain';
}

async function readAsText(file) {
  return file.text();
}

async function readAsJSON(file) {
  const raw = await file.text();
  try {
    const parsed = JSON.parse(raw);
    // Flatten any stringy content in the JSON for classification
    return flattenJSONForClassification(parsed);
  } catch(e) {
    return raw;
  }
}

function flattenJSONForClassification(obj, depth = 0) {
  if (depth > 8) return '';
  if (obj == null) return '';
  if (typeof obj === 'string') return obj + '\n';
  if (typeof obj !== 'object') return String(obj) + '\n';
  if (Array.isArray(obj)) return obj.map(x => flattenJSONForClassification(x, depth+1)).join('\n');
  return Object.entries(obj).map(([k, v]) => {
    if (typeof v === 'string' && v.length > 2 && v.length < 2000) return `${k}: ${v}`;
    if (typeof v === 'object') return flattenJSONForClassification(v, depth+1);
    return '';
  }).filter(Boolean).join('\n');
}

/* ═══ Batch ingest with progress ═══════════════════════════════════════ */

/**
 * Run ingestion on a file. Progress callback fires per batch of clauses.
 * Returns summary: { file, chars, clauses, emitted, nul_gated, failed }.
 */
export async function ingestFile(file, onProgress) {
  onProgress?.({ phase: 'reading', file: file.name });
  const text = await extractText(file);
  onProgress?.({ phase: 'classifying', file: file.name, chars: text.length });
  // The intake pipeline already splits into clauses; we let it run fully
  const results = await ingest(text, { frame: 'default', agent: 'import', source: file.name });
  const emitted = results.filter(r => r.status === 'emitted' || r.status === 'low_confidence');
  const gated = results.filter(r => r.status === 'nul_gated');
  const failed = results.filter(r => r.status === 'error' || r.status === 'model_failed');
  onProgress?.({
    phase: 'done',
    file: file.name,
    clauses: results.length,
    emitted: emitted.length,
    nul_gated: gated.length,
    failed: failed.length
  });
  return {
    file: file.name,
    chars: text.length,
    clauses: results.length,
    emitted: emitted.length,
    nul_gated: gated.length,
    failed: failed.length,
    events: emitted.map(r => r.event)
  };
}

/* ═══ Drop-zone helper for a UI element ════════════════════════════════ */

export function attachDropZone(el, onFiles) {
  const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter','dragover','dragleave','drop'].forEach(ev => {
    el.addEventListener(ev, prevent, false);
  });
  el.addEventListener('dragenter', () => el.classList.add('drop-active'));
  el.addEventListener('dragover', () => el.classList.add('drop-active'));
  el.addEventListener('dragleave', () => el.classList.remove('drop-active'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop-active');
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) onFiles(files);
  });
}

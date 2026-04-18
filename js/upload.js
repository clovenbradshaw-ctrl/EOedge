// ══════════════════════════════════════════════════════════════════════
// upload.js — document drop zone
//
// Accepts plain text, markdown, CSV, JSON text, and PDF. PDF extraction
// lazy-loads pdf.js from a CDN on first use so the main-thread boot
// stays lean. DOCX would plug in identically via mammoth.
// ══════════════════════════════════════════════════════════════════════

import { ingest } from './intake.js';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB safety cap (bumped for PDFs)

const EXTRACTORS = {
  'text/plain':       readAsText,
  'text/markdown':    readAsText,
  'text/csv':         readAsText,
  'application/json': readAsJSON,
  'application/x-ndjson': readAsText,
  'application/pdf':  readAsPDF
};

// Supported extensions. Anything else — DOCX, images, archives — is
// rejected up front instead of being read as text (which produces binary
// garbage that the classifier then fails or NUL-gates).
const SUPPORTED_EXTS = new Set(['txt','md','markdown','log','csv','json','ndjson','jsonl','pdf']);

export async function extractText(file) {
  if (!file) throw new Error('no file');
  if (file.size > MAX_BYTES) throw new Error(`file too large (${file.size} bytes; limit ${MAX_BYTES})`);
  const ext = fileExt(file.name);
  if (!SUPPORTED_EXTS.has(ext)) {
    throw new Error(`unsupported file type ".${ext || '?'}" — drop .txt, .md, .csv, .json, .log, or .pdf`);
  }
  const type = file.type || inferType(ext);
  const extractor = EXTRACTORS[type] || readAsText;
  return extractor(file);
}

function fileExt(name) {
  return (String(name || '').split('.').pop() || '').toLowerCase();
}

function inferType(ext) {
  if (['md','markdown','txt','log'].includes(ext)) return 'text/plain';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'json') return 'application/json';
  if (ext === 'ndjson' || ext === 'jsonl') return 'application/x-ndjson';
  if (ext === 'pdf') return 'application/pdf';
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

/* ═══ PDF via pdf.js (lazy) ════════════════════════════════════════════ */

const PDFJS_VERSION = '4.7.76';
const PDFJS_MODULE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.mjs`;
const PDFJS_WORKER = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.mjs`;
let _pdfjsPromise = null;

function loadPdfJs() {
  if (_pdfjsPromise) return _pdfjsPromise;
  _pdfjsPromise = (async () => {
    const mod = await import(/* @vite-ignore */ PDFJS_MODULE);
    mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return mod;
  })().catch(e => { _pdfjsPromise = null; throw e; });
  return _pdfjsPromise;
}

async function readAsPDF(file) {
  const pdfjs = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Each item is a glyph run. Join with spaces and preserve paragraph
    // breaks where pdf.js marks end-of-line.
    const line = content.items.map(it => {
      const t = it.str || '';
      return it.hasEOL ? t + '\n' : t;
    }).join(' ');
    pages.push(line);
    page.cleanup?.();
  }
  doc.destroy?.();
  // Collapse runs of whitespace the intake clause-splitter would choke on.
  return pages.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
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

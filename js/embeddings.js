// ══════════════════════════════════════════════════════════════════════
// embeddings.js — semantic classification via 27-cell centroids
//
// Loads all-MiniLM-L6-v2 via transformers.js (first-run ~24 MB download,
// cached by browser). Fetches exemplars.json from the lexical-analysis
// repo, embeds the top-margin clauses per cell, averages into 27
// centroids, caches centroids in localStorage for subsequent loads.
//
// The classifier is layered: heuristic runs first (zero cost, fast),
// embeddings refine when heuristic is ambiguous or when the caller
// explicitly requests semantic classification.
// ══════════════════════════════════════════════════════════════════════

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
// Try a vendored copy first so the app works offline / without GitHub raw
// being reachable, then fall back to the upstream lexical-analysis repo.
const EXEMPLARS_SOURCES = [
  { label: 'local',    url: new URL('../data/exemplars.json', import.meta.url).toString() },
  { label: 'upstream', url: 'https://raw.githubusercontent.com/clovenbradshaw-ctrl/eo-lexical-analysis-2.0/main/run_2026-03-19_144302/exemplars.json' }
];
const TOP_N = 40;
const MIN_MARGIN = 0.03;
const CENTROIDS_LS_KEY = 'eo-local-centroids-v1';

const OP_MAP = {
  NUL: { mode: 'Differentiating', domain: 'Existence' },
  SIG: { mode: 'Relating',        domain: 'Existence' },
  INS: { mode: 'Generating',      domain: 'Existence' },
  SEG: { mode: 'Differentiating', domain: 'Structure' },
  CON: { mode: 'Relating',        domain: 'Structure' },
  SYN: { mode: 'Generating',      domain: 'Structure' },
  ALT: { mode: 'Differentiating', domain: 'Significance' },
  SUP: { mode: 'Relating',        domain: 'Significance' },
  REC: { mode: 'Generating',      domain: 'Significance' }
};

const RES_OBJECT = {
  Clearing:    'Condition', Dissecting: 'Entity', Unraveling: 'Pattern',
  Tending:     'Condition', Binding:    'Entity', Tracing:    'Pattern',
  Cultivating: 'Condition', Making:     'Entity', Composing:  'Pattern'
};

let _embedder = null;
let _centroids = null;
let _cellOrder = null;
let _loading = null;

/* ═══ Status ═══════════════════════════════════════════════════════════ */

export function isReady() { return !!_centroids; }
export function isLoading() { return !!_loading; }

/* ═══ Model pipeline ══════════════════════════════════════════════════ */

async function loadEmbedder(onProgress) {
  if (_embedder) return _embedder;
  onProgress?.('Loading transformers.js…', 0.02);
  const mod = await import(/* @vite-ignore */ TRANSFORMERS_URL);
  mod.env.allowLocalModels = false;
  mod.env.useBrowserCache = true;
  onProgress?.('Loading MiniLM…', 0.1);
  _embedder = await mod.pipeline('feature-extraction', MODEL_ID, {
    quantized: true,
    progress_callback: (data) => {
      if (data.status === 'progress' && typeof data.progress === 'number') {
        onProgress?.(`${data.file} ${Math.round(data.progress)}%`, 0.1 + (data.progress / 100) * 0.3);
      }
    }
  });
  onProgress?.('Model ready', 0.4);
  return _embedder;
}

export async function embed(text) {
  if (!_embedder) await loadEmbedder();
  const out = await _embedder(String(text || ''), { pooling: 'mean', normalize: true });
  return out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
}

async function embedBatch(texts, onProgress) {
  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) {
    out[i] = await embed(texts[i]);
    if (i % 8 === 0 || i === texts.length - 1) {
      onProgress?.(`Embedding ${i+1}/${texts.length}`, 0.4 + (i / texts.length) * 0.55);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return out;
}

async function fetchExemplars() {
  const errors = [];
  for (const { label, url } of EXEMPLARS_SOURCES) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      errors.push(`${label} ${r.status}`);
    } catch(e) {
      errors.push(`${label} ${e.message || 'network error'}`);
    }
  }
  throw new Error(`exemplars unavailable (${errors.join(', ')})`);
}

/* ═══ Centroids ═══════════════════════════════════════════════════════ */

function loadCachedCentroids() {
  try {
    const raw = localStorage.getItem(CENTROIDS_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const centroids = {};
    for (const [k, arr] of Object.entries(parsed.centroids || {})) {
      centroids[k] = new Float32Array(arr);
    }
    return { centroids, cellOrder: parsed.cellOrder };
  } catch(e) { return null; }
}

function saveCachedCentroids(centroids, cellOrder) {
  try {
    const out = { centroids: {}, cellOrder, saved_at: new Date().toISOString() };
    for (const [k, vec] of Object.entries(centroids)) out.centroids[k] = Array.from(vec);
    localStorage.setItem(CENTROIDS_LS_KEY, JSON.stringify(out));
  } catch(e) { console.warn('[embeddings] centroid save failed:', e); }
}

/**
 * Ensure centroids are loaded. If cached, returns instantly. Otherwise
 * loads the embedder, fetches exemplars, and bakes. Idempotent.
 */
export async function ensureCentroids(onProgress, { force = false } = {}) {
  if (_centroids && !force) return { cached: true, cells: _cellOrder.length };
  if (_loading && !force) return _loading;

  _loading = (async () => {
    if (!force) {
      const cached = loadCachedCentroids();
      if (cached) {
        _centroids = cached.centroids;
        _cellOrder = cached.cellOrder;
        onProgress?.('Loaded cached centroids', 1.0);
        return { cached: true, cells: _cellOrder.length };
      }
    }

    await loadEmbedder(onProgress);
    onProgress?.('Fetching exemplars…', 0.4);
    const data = await fetchExemplars();
    const cells = data['27cell'];
    if (!cells) throw new Error('exemplars.json missing "27cell"');

    const cellKeys = Object.keys(cells);
    const tasks = [];
    for (const key of cellKeys) {
      const ranked = [...cells[key]].sort((a, b) => (b.margin || 0) - (a.margin || 0));
      let top = ranked.filter(e => (e.margin || 0) >= MIN_MARGIN).slice(0, TOP_N);
      if (!top.length) top = ranked.slice(0, Math.min(10, ranked.length));
      for (const ex of top) tasks.push({ key, text: ex.text });
    }
    const vectors = await embedBatch(tasks.map(t => t.text), onProgress);

    const DIM = vectors[0]?.length || 384;
    const sums = Object.fromEntries(cellKeys.map(k => [k, { sum: new Float32Array(DIM), n: 0 }]));
    for (let i = 0; i < tasks.length; i++) {
      const { key } = tasks[i];
      const v = vectors[i];
      const acc = sums[key].sum;
      for (let j = 0; j < DIM; j++) acc[j] += v[j];
      sums[key].n += 1;
    }
    const centroids = {};
    for (const key of cellKeys) {
      const { sum, n } = sums[key];
      if (n === 0) continue;
      const avg = new Float32Array(DIM);
      let norm = 0;
      for (let j = 0; j < DIM; j++) { avg[j] = sum[j] / n; norm += avg[j] * avg[j]; }
      norm = Math.sqrt(norm) || 1;
      for (let j = 0; j < DIM; j++) avg[j] /= norm;
      centroids[key] = avg;
    }
    _centroids = centroids;
    _cellOrder = Object.keys(centroids);
    saveCachedCentroids(centroids, _cellOrder);
    onProgress?.('Centroids baked', 1.0);
    return { cached: false, cells: _cellOrder.length };
  })();

  try { return await _loading; }
  finally { _loading = null; }
}

/* ═══ Classify ═══════════════════════════════════════════════════════ */

/**
 * Classify a string to its nearest cell via cosine similarity.
 * Returns { cell, operator, site, resolution, mode, domain, object,
 *           sim, margin, confidence, top }.
 */
export async function classify(text) {
  if (!_centroids) await ensureCentroids();
  const v = await embed(text);
  const sims = new Array(_cellOrder.length);
  for (let i = 0; i < _cellOrder.length; i++) {
    const c = _centroids[_cellOrder[i]];
    let s = 0;
    for (let j = 0; j < c.length; j++) s += v[j] * c[j];
    sims[i] = [_cellOrder[i], s];
  }
  sims.sort((a, b) => b[1] - a[1]);
  const [bestCell, bestSim] = sims[0];
  const margin = bestSim - (sims[1]?.[1] || 0);
  const parsed = parseCellKey(bestCell);
  const confidence = Math.max(0, Math.min(1,
    0.4 * Math.max(0, bestSim) + 0.6 * Math.min(1, margin * 5)
  ));
  return {
    cell: bestCell,
    operator: parsed.operator,
    site: parsed.site,
    resolution: parsed.resolution,
    mode: parsed.mode,
    domain: parsed.domain,
    object: parsed.object,
    sim: +bestSim.toFixed(4),
    margin: +margin.toFixed(4),
    confidence: +confidence.toFixed(3),
    top: sims.slice(0, 3).map(([c, s]) => [c, +s.toFixed(4)])
  };
}

function parseCellKey(key) {
  const m = /^([A-Z]{3})\(([^,]+),\s*([^)]+)\)$/.exec(String(key || '').trim());
  if (!m) return { operator: '', site: '', resolution: '', mode: '', domain: '', object: '' };
  const operator = m[1];
  const resolution = m[2].trim();
  const site = m[3].trim();
  const opInfo = OP_MAP[operator] || { mode: '', domain: '' };
  const object = RES_OBJECT[resolution] || '';
  return { operator, site, resolution, mode: opInfo.mode, domain: opInfo.domain, object };
}

export function clearCentroidCache() {
  try { localStorage.removeItem(CENTROIDS_LS_KEY); } catch(e) {}
  _centroids = null;
  _cellOrder = null;
}

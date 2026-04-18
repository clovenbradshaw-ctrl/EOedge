// ══════════════════════════════════════════════════════════════════════
// zoom.js — hierarchical SPO / classification at any granularity
//
// The EO algebra scales: the same nine operators classify a clause, a
// sentence, a paragraph, a section, or a whole document. This module
// parses text into a structural tree and offers on-demand SPO +
// classification at any node. Nothing is precomputed unless a caller
// asks, so opening a document is cheap even when it's long.
//
// Tree shape:
//   {
//     id:       stable string
//     level:    'document' | 'section' | 'paragraph' | 'sentence' | 'clause'
//     text:     the slice of the parent's text
//     span:     [start, end] byte offsets into the document
//     children: [subnode, …]              (empty on clauses)
//     spo?:         { s, p, o }           (populated by classify())
//     cell?:        { operator, mode, domain, object, resolution, site }
//     confidence?:  number
//     source?:      'heuristic' | 'model'
//     rationale?:   string
//   }
// ══════════════════════════════════════════════════════════════════════

import { splitIntoClauses } from './intake.js';
import { classifyHeuristic, extractSPO } from './heuristic.js';

const LEVELS = ['document', 'section', 'paragraph', 'sentence', 'clause'];
const LEVEL_INDEX = Object.fromEntries(LEVELS.map((l, i) => [l, i]));

/* ═══ Chunking ═════════════════════════════════════════════════════════ */

/**
 * Parse a raw string into a document tree.
 * Lazy: no classification runs until classify()/zoom() asks for it.
 *
 * @param {string} text
 * @param {{docId?: string}} [options]
 * @returns root node (level='document')
 */
export function chunk(text, { docId } = {}) {
  const raw = String(text || '');
  const id = docId || `doc-${cyrb32(raw).toString(16)}`;
  const sections = splitSections(raw);
  const sectionNodes = sections.map((s, i) => buildSection(s.text, s.start, `${id}:sec${i}`));
  return {
    id,
    level: 'document',
    text: raw,
    span: [0, raw.length],
    children: sectionNodes
  };
}

function buildSection(text, start, id) {
  const paragraphs = splitParagraphs(text);
  const children = paragraphs.map((p, i) =>
    buildParagraph(p.text, start + p.start, `${id}:p${i}`));
  return {
    id,
    level: 'section',
    text,
    span: [start, start + text.length],
    children
  };
}

function buildParagraph(text, start, id) {
  const sentences = splitSentences(text);
  const children = sentences.map((s, i) =>
    buildSentence(s.text, start + s.start, `${id}:s${i}`));
  return {
    id,
    level: 'paragraph',
    text,
    span: [start, start + text.length],
    children
  };
}

function buildSentence(text, start, id) {
  // Reuse intake's clause splitter so clause boundaries match the pipeline.
  const clauses = splitIntoClauses(text);
  let cursor = 0;
  const children = clauses.map((c, i) => {
    const idx = text.indexOf(c, cursor);
    const at = idx >= 0 ? idx : cursor;
    cursor = at + c.length;
    return {
      id: `${id}:c${i}`,
      level: 'clause',
      text: c,
      span: [start + at, start + at + c.length],
      children: []
    };
  });
  return {
    id,
    level: 'sentence',
    text,
    span: [start, start + text.length],
    children
  };
}

/* ═══ Splitters ════════════════════════════════════════════════════════ */

/** Section split: markdown-ish headings (line starts with `# `/`## `…) or
 *  a `\n\n\n+` blank-line run. Preserves offsets. */
function splitSections(text) {
  if (!text) return [];
  const out = [];
  const re = /(^|\n)(#{1,6}\s[^\n]*\n|\n{2,})/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const boundary = m.index + m[1].length;
    if (boundary > last) {
      const slice = text.slice(last, boundary);
      if (slice.trim()) out.push({ text: slice, start: last });
    }
    last = boundary;
  }
  if (last < text.length) {
    const slice = text.slice(last);
    if (slice.trim()) out.push({ text: slice, start: last });
  }
  return out.length ? out : [{ text, start: 0 }];
}

/** Paragraph split: blank-line separated. */
function splitParagraphs(text) {
  const out = [];
  const re = /\n{2,}/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const slice = text.slice(last, m.index);
    if (slice.trim()) out.push({ text: slice, start: last });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const slice = text.slice(last);
    if (slice.trim()) out.push({ text: slice, start: last });
  }
  return out.length ? out : [{ text, start: 0 }];
}

/** Sentence split: `[.!?]` followed by whitespace + capital/quote. */
function splitSentences(text) {
  const out = [];
  const re = /(?<=[.!?])\s+(?=[A-Z"'(])/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const slice = text.slice(last, m.index + 1);
    if (slice.trim()) out.push({ text: slice.trim(), start: last });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const slice = text.slice(last);
    if (slice.trim()) out.push({ text: slice.trim(), start: last });
  }
  return out.length ? out : [{ text: text.trim(), start: 0 }];
}

/* ═══ Classification (lazy) ═══════════════════════════════════════════ */

/**
 * Ensure `node` has spo/cell/confidence/source fields. Idempotent.
 *
 * The heuristic classifier works on arbitrary length text but was tuned
 * for clauses, so higher levels use the same scoring but treat low
 * confidence gracefully. If `modelClassify` is provided it's called
 * when the heuristic is ambiguous.
 *
 * @param {object} node
 * @param {{modelClassify?: (text:string) => Promise<object>}} [options]
 */
export async function classify(node, { modelClassify } = {}) {
  if (!node || node.spo) return node;
  const text = node.text || '';
  if (!text.trim()) {
    node.spo = { s: '', p: '', o: '' };
    node.source = 'empty';
    return node;
  }

  const heur = classifyHeuristic(text);
  if (!heur.nul_gate && !heur.ambiguous && heur.operator) {
    applyClassification(node, heur, 'heuristic');
    return node;
  }

  if (modelClassify) {
    try {
      const m = await modelClassify(text);
      applyClassification(node, m, 'model');
      return node;
    } catch(e) {
      // fall through to heuristic best-guess below
    }
  }

  // Fallback: SPO only, no operator commitment.
  node.spo = extractSPO(text);
  node.source = 'heuristic-spo-only';
  node.confidence = heur.confidence || 0;
  return node;
}

function applyClassification(node, r, source) {
  node.spo = r.spo || extractSPO(node.text || '');
  node.cell = {
    operator: r.operator || '',
    mode: r.mode || '',
    domain: r.domain || '',
    object: r.object || '',
    resolution: r.resolution || '',
    site: r.site || ''
  };
  node.confidence = typeof r.confidence === 'number' ? r.confidence : 0;
  node.source = source;
  node.rationale = r.rationale || '';
}

/* ═══ Zoom ═════════════════════════════════════════════════════════════ */

/**
 * Collapse a tree to a given granularity and ensure every node at that
 * level is classified. Higher (coarser) levels classify on the whole
 * span; lower (finer) levels classify per clause.
 *
 * @param {object} tree      root (level='document')
 * @param {string} level     one of LEVELS
 * @param {{modelClassify?: Function, limit?: number}} [options]
 * @returns {Promise<object[]>} array of classified nodes at that level
 */
export async function zoom(tree, level, options = {}) {
  if (!(level in LEVEL_INDEX)) throw new Error(`Unknown zoom level: ${level}`);
  const nodes = nodesAtLevel(tree, level);
  const limit = options.limit || nodes.length;
  for (const n of nodes.slice(0, limit)) {
    await classify(n, options);
  }
  return nodes;
}

/** Walk the tree, collect every node at a given level. Coarser levels
 *  may also include the root (document itself is a valid level). */
export function nodesAtLevel(tree, level) {
  const want = LEVEL_INDEX[level];
  const out = [];
  const stack = [tree];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    const depth = LEVEL_INDEX[n.level];
    if (depth === want) {
      out.push(n);
      continue;
    }
    if (depth < want && n.children?.length) {
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
  }
  return out.reverse();
}

/* ═══ Background classification ════════════════════════════════════════ */

/**
 * Classify nodes in the background, cheapest-first. The caller passes a
 * yield function (default: requestIdleCallback) so this plays nicely
 * with the UI thread.
 *
 * Cancelation: call the returned stop() function.
 */
export function backgroundClassify(tree, { levels = ['clause'], modelClassify, yielder, onProgress } = {}) {
  const queue = [];
  for (const lvl of levels) {
    for (const n of nodesAtLevel(tree, lvl)) {
      if (!n.spo) queue.push(n);
    }
  }
  const total = queue.length;
  let done = 0;
  let cancelled = false;

  const schedule = yielder || ((cb) => {
    if (typeof requestIdleCallback !== 'undefined') return requestIdleCallback(cb);
    return setTimeout(cb, 16);
  });

  async function tick() {
    if (cancelled) return;
    const node = queue.shift();
    if (!node) return;
    await classify(node, { modelClassify });
    done++;
    onProgress?.(done, total);
    schedule(tick);
  }

  schedule(tick);
  return () => { cancelled = true; };
}

/* ═══ Helpers ══════════════════════════════════════════════════════════ */

/** cyrb32 — tiny non-cryptographic string hash for stable node ids. */
function cyrb32(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export { LEVELS };

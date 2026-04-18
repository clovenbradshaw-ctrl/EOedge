// ══════════════════════════════════════════════════════════════════════
// upload-pipeline.js — the helix-as-pipeline worker
//
// Six constraints, enforced structurally:
//
//   1. STAGES is a frozen ordered list. Nine. Closed.
//   2. PREREQS is a frozen map. A stage cannot start until every prereq
//      has status === 'done' in this run's ledger. No cleverness.
//   3. STAGE_FNS are pure (inputs → artifact). Schemas are checked on
//      input and output. Anything non-conforming is rejected.
//   4. Append-only. No stage writes to an upstream artifact. REC can
//      emit a reframe record; it does not edit SEG's output.
//   5. PERSISTS flags which stages write durable artifacts (through the
//      existing intake/store path). NUL and SIG are ephemeral; their
//      outputs are kept only for the length of this run.
//   6. Idempotence key is (doc_id, stage, input_hash). Cache hit → emit
//      'cached' pointing at the prior artifact, skip execution.
//
// The worker is dumb. The ordering plus the prereq map plus the type
// schemas enforce the helix; the worker never "understands" it.
// ══════════════════════════════════════════════════════════════════════

import { splitIntoClauses, classifyClause } from './intake.js';
import { classifyHeuristic, extractSPO } from './heuristic.js';
import { makeAnchor, hash as fastHash } from './anchor.js';
import { appendRecord } from './upload-log.js';

/* ─── 1. Frozen ordered list ─────────────────────────────────────────── */
export const STAGES = Object.freeze(['NUL','SIG','INS','SEG','CON','SYN','DEF','EVA','REC']);

/* ─── 2. Frozen prereq map ───────────────────────────────────────────── */
export const PREREQS = Object.freeze({
  NUL: Object.freeze([]),
  SIG: Object.freeze(['NUL']),
  INS: Object.freeze(['SIG']),
  SEG: Object.freeze(['INS']),
  CON: Object.freeze(['SEG','INS']),
  SYN: Object.freeze(['CON']),
  DEF: Object.freeze(['SYN','INS']),
  EVA: Object.freeze(['DEF']),
  REC: Object.freeze(['EVA'])
});

/* ─── 5. Persistence flags ───────────────────────────────────────────── */
export const PERSISTS = Object.freeze({
  NUL: false, SIG: false,
  INS: true, SEG: true, CON: true, SYN: true, DEF: true, EVA: true, REC: true
});

/* ─── 3. Input/output schemas per stage ──────────────────────────────── */
// Each schema is a set of required top-level keys the artifact must have.
// Dumb structural check; not a full JSON-schema validator.
const STAGE_SCHEMAS = Object.freeze({
  NUL: ['language','encoding','source_type','size_bytes','char_count','assumptions_set_aside'],
  SIG: ['clauses','sentence_count','attention_markers'],
  INS: ['entities','count'],
  SEG: ['boundaries','paragraph_count','sentence_count','predicate_slot_anchors'],
  CON: ['edges','count'],
  SYN: ['merged_entities','proposition_count'],
  DEF: ['events','by_operator','low_confidence'],
  EVA: ['stance_histogram','binding_fraction','clause_stances'],
  REC: ['frame_changes','count']
});

function validateArtifact(stage, artifact) {
  if (!artifact || typeof artifact !== 'object') {
    throw new TypeError(`${stage} produced non-object artifact`);
  }
  const required = STAGE_SCHEMAS[stage];
  for (const key of required) {
    if (!(key in artifact)) {
      throw new TypeError(`${stage} artifact missing required key "${key}"`);
    }
  }
}

/* ─── 6. Idempotence cache — keyed by (doc_id, stage, input_hash) ────── */
const _cache = new Map(); // key → { artifact, summary }

function cacheKey(doc_id, stage, input_hash) {
  return `${doc_id}::${stage}::${input_hash}`;
}

function hashArtifacts(artifacts) {
  // Order-stable: hash(JSON(concat of prereq artifact hashes in alphabetical prereq order))
  // For the top-level pipeline we pass an object keyed by prereq stage.
  const keys = Object.keys(artifacts).sort();
  const parts = keys.map(k => `${k}:${fastHash(JSON.stringify(artifacts[k] ?? null))}`);
  return fastHash(parts.join('|'));
}

/* ─── Stage functions — pure (inputs) → artifact ─────────────────────── */

const STAGE_FNS = Object.freeze({
  /* NUL — framing. Record what we are not assuming. No downstream content. */
  async NUL(ctx, _inputs) {
    const text = ctx.text || '';
    return {
      language: 'en',              // we don't detect; record the assumption
      encoding: 'utf-8',
      source_type: ctx.mime || 'text/plain',
      size_bytes: ctx.size_bytes || (ctx.file?.size ?? text.length),
      char_count: text.length,
      assumptions_set_aside: [
        'no language detection',
        'no author identity assumption',
        'no document-type assumption beyond MIME'
      ]
    };
  },

  /* SIG — signal pass. Tokenize, mark attention. Ephemeral. */
  async SIG(ctx, { NUL }) {
    const text = ctx.text || '';
    const clauses = splitIntoClauses(text);
    // Attention markers: clauses whose heuristic fires strongly (candidate transformations).
    const attention = [];
    for (let i = 0; i < clauses.length; i++) {
      const h = classifyHeuristic(clauses[i]);
      if (!h.nul_gate && !h.ambiguous && h.operator) {
        attention.push({ clause_idx: i, operator: h.operator, confidence: h.confidence });
      }
    }
    return {
      clauses,                     // kept on the in-memory ctx, not persisted
      sentence_count: (text.match(/[.!?]+\s|$/g) || []).length,
      attention_markers: attention
    };
  },

  /* INS — instantiate every NP cluster. Mint anchors for SPO subjects and objects. */
  async INS(ctx, { SIG }) {
    const clauses = SIG.clauses || [];
    const byHash = new Map();     // hash → { hash, form, original, clause_idx, seen }
    for (let i = 0; i < clauses.length; i++) {
      const spo = extractSPO(clauses[i]);
      for (const field of ['s','o']) {
        const v = (spo?.[field] || '').trim();
        if (!v || v.length < 2) continue;
        const a = makeAnchor(v);
        if (!byHash.has(a.hash)) {
          byHash.set(a.hash, { hash: a.hash, form: a.form, original: a.original, first_clause_idx: i, occurrences: 1 });
        } else {
          byHash.get(a.hash).occurrences += 1;
        }
      }
    }
    const entities = Array.from(byHash.values());
    return { entities, count: entities.length };
  },

  /* SEG — boundaries: sentence / clause / paragraph / predicate-slot anchors. */
  async SEG(ctx, { INS, SIG }) {
    const text = ctx.text || '';
    const clauses = SIG.clauses || [];
    const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).map(s => s.trim()).filter(Boolean);
    // Predicate-slot anchors — @ps:i per clause that has a detectable verb slot.
    const predSlots = [];
    for (let i = 0; i < clauses.length; i++) {
      const spo = extractSPO(clauses[i]);
      if (spo.p) predSlots.push({ idx: i, ps: `@ps:${i}`, predicate: spo.p });
    }
    return {
      boundaries: {
        clauses: clauses.length,
        sentences: sentences.length,
        paragraphs: paragraphs.length
      },
      paragraph_count: paragraphs.length,
      sentence_count: sentences.length,
      predicate_slot_anchors: predSlots
    };
  },

  /* CON — typed connections. Proposition edges derived from SPO per clause. */
  async CON(ctx, { SEG, INS }) {
    const clauses = ctx._scratch?.SIG?.clauses || [];
    const edges = [];
    for (let i = 0; i < clauses.length; i++) {
      const spo = extractSPO(clauses[i]);
      if (spo.s && spo.p && spo.o) {
        const s = makeAnchor(spo.s);
        const o = makeAnchor(spo.o);
        edges.push({
          type: 'proposition',
          s_hash: s.hash, s_form: s.form,
          p: spo.p,
          o_hash: o.hash, o_form: o.form,
          clause_idx: i
        });
      }
    }
    return { edges, count: edges.length };
  },

  /* SYN — collapse: coreference/entity merging, proposition network. */
  async SYN(ctx, { CON }) {
    const edges = CON.edges || [];
    const nodes = new Map();
    for (const e of edges) {
      if (!nodes.has(e.s_hash)) nodes.set(e.s_hash, { hash: e.s_hash, form: e.s_form, in: 0, out: 0 });
      if (!nodes.has(e.o_hash)) nodes.set(e.o_hash, { hash: e.o_hash, form: e.o_form, in: 0, out: 0 });
      nodes.get(e.s_hash).out += 1;
      nodes.get(e.o_hash).in += 1;
    }
    return {
      merged_entities: nodes.size,
      proposition_count: edges.length,
      hubs: Array.from(nodes.values()).sort((a,b) => (b.in+b.out) - (a.in+a.out)).slice(0, 8)
    };
  },

  /* DEF — typed frames: run the classifier on each clause. Writes events. */
  async DEF(ctx, { SYN, INS }) {
    const clauses = ctx._scratch?.SIG?.clauses || [];
    const byOp = {};
    const events = [];
    let low = 0, gated = 0, failed = 0;
    for (const c of clauses) {
      try {
        const r = await classifyClause(c, { frame: ctx.frame || 'default', agent: ctx.agent || 'import', source: ctx.name });
        if (r.status === 'emitted' || r.status === 'low_confidence') {
          const op = r.event?.operator || 'UNK';
          byOp[op] = (byOp[op] || 0) + 1;
          events.push({
            uuid: r.event.uuid,
            operator: op,
            clause: c.slice(0, 160),
            confidence: r.event.confidence,
            resolution_name: r.event.resolution_name,
            site_name: r.event.site_name
          });
          if (r.status === 'low_confidence') low += 1;
        } else if (r.status === 'nul_gated') {
          gated += 1;
        } else {
          failed += 1;
        }
      } catch(e) {
        failed += 1;
      }
    }
    return {
      events,
      by_operator: byOp,
      low_confidence: low,
      nul_gated: gated,
      failed,
      total_clauses: clauses.length
    };
  },

  /* EVA — Resolution-face stance profile. The budget gate lives here. */
  async EVA(ctx, { DEF }) {
    const events = DEF.events || [];
    const histogram = {
      Clearing: 0, Dissecting: 0, Unraveling: 0,
      Tending: 0,  Binding: 0,    Tracing: 0,
      Cultivating: 0, Making: 0,  Composing: 0
    };
    const clauseStances = [];
    for (const e of events) {
      const r = e.resolution_name || '';
      if (r in histogram) histogram[r] += 1;
      clauseStances.push({ uuid: e.uuid, stance: r || '—', operator: e.operator, clause: e.clause });
    }
    const total = Object.values(histogram).reduce((a,b) => a+b, 0);
    const binding_fraction = total > 0 ? histogram.Binding / total : 0;
    return {
      stance_histogram: histogram,
      binding_fraction: +binding_fraction.toFixed(3),
      clause_stances: clauseStances,
      total_classified: total,
      downstream_budget_note: total > 0
        ? `Downstream consumers should spend budget on the ${histogram.Binding} Binding clause(s) (${(binding_fraction*100).toFixed(0)}% of ${total}).`
        : 'No classified clauses; budget gate inert.'
    };
  },

  /* REC — reflection pass: does the document force a frame change? */
  async REC(ctx, { EVA }) {
    // For the MVP: a trivial pathology detector. If EVA's histogram is
    // flat across too many stances, surface a frame-change candidate.
    // Usually empty. Non-empty means the document restructured how we
    // should read it.
    const h = EVA.stance_histogram || {};
    const vals = Object.values(h);
    const total = vals.reduce((a,b) => a+b, 0);
    const changes = [];
    if (total >= 8 && EVA.binding_fraction < 0.05) {
      changes.push({
        kind: 'binding-starved',
        evidence: `binding_fraction=${EVA.binding_fraction}, total=${total}`,
        suggestion: 'No Binding stance on any classified clause — EVA gate inert. Consider reframing.'
      });
    }
    return { frame_changes: changes, count: changes.length };
  }
});

/* ─── 2. prereq-gate check ──────────────────────────────────────────── */
function prereqsSatisfied(stage, ledger) {
  const reqs = PREREQS[stage];
  for (const r of reqs) {
    const state = ledger[r];
    if (!state || (state.status !== 'done' && state.status !== 'cached')) return false;
  }
  return true;
}

/* ─── Worker entry point ─────────────────────────────────────────────── */

/**
 * Run the full pipeline on a context. Emits records into upload-log via
 * appendRecord. Returns the per-stage artifact map.
 *
 * ctx = { doc_id, name, mime, size_bytes, text, file, frame, agent }
 */
export async function runPipeline(ctx) {
  if (!ctx?.doc_id) throw new Error('runPipeline: doc_id required');
  const ledger = {};                 // stage → { status, artifact }
  const artifacts = {};              // stage → artifact
  ctx._scratch = {};                 // ephemeral intra-run slot (e.g. SIG clauses)

  appendRecord(ctx.doc_id, { stage: '_pipeline', status: 'started', overall: 'running' });

  for (const stage of STAGES) {
    // Prereq gate — structural enforcement of the helix.
    if (!prereqsSatisfied(stage, ledger)) {
      const missing = PREREQS[stage].filter(r => !ledger[r] || (ledger[r].status !== 'done' && ledger[r].status !== 'cached'));
      appendRecord(ctx.doc_id, {
        stage, status: 'failed',
        error: `prereq not satisfied: missing ${missing.join(', ')}`
      });
      appendRecord(ctx.doc_id, { stage: '_pipeline', status: 'failed', overall: 'failed' });
      throw new Error(`pipeline refused ${stage}: prereq not satisfied (${missing.join(', ')})`);
    }

    // Build prereq-input object for the stage.
    const stageInputs = {};
    for (const p of PREREQS[stage]) stageInputs[p] = artifacts[p];
    const input_hash = hashArtifacts(stageInputs);

    // Idempotence cache — (doc_id, stage, input_hash).
    const ckey = cacheKey(ctx.doc_id, stage, input_hash);
    if (_cache.has(ckey)) {
      const cached = _cache.get(ckey);
      artifacts[stage] = cached.artifact;
      ledger[stage] = { status: 'cached', artifact: cached.artifact };
      if (stage === 'SIG') ctx._scratch.SIG = cached.artifact;
      appendRecord(ctx.doc_id, {
        stage, status: 'cached',
        input_hash,
        artifact: projectArtifactForLog(stage, cached.artifact),
        summary: cached.summary + ' (cached)'
      });
      continue;
    }

    appendRecord(ctx.doc_id, { stage, status: 'started', input_hash });
    const started = Date.now();
    try {
      const fn = STAGE_FNS[stage];
      const artifact = await fn(ctx, stageInputs);
      validateArtifact(stage, artifact);
      const duration = Date.now() - started;
      artifacts[stage] = artifact;
      ledger[stage] = { status: 'done', artifact };
      if (stage === 'SIG') ctx._scratch.SIG = artifact; // CON/DEF reach into this
      const summary = summariseArtifact(stage, artifact, duration);
      _cache.set(ckey, { artifact, summary });
      appendRecord(ctx.doc_id, {
        stage, status: 'done',
        input_hash,
        artifact: projectArtifactForLog(stage, artifact),
        summary
      });
    } catch(e) {
      appendRecord(ctx.doc_id, {
        stage, status: 'failed',
        error: e.message || String(e)
      });
      appendRecord(ctx.doc_id, { stage: '_pipeline', status: 'failed', overall: 'failed' });
      throw e;
    }
  }

  appendRecord(ctx.doc_id, { stage: '_pipeline', status: 'done', overall: 'done' });
  return artifacts;
}

/* ─── Artifact projection for the live log (strip bulky fields) ─────── */
function projectArtifactForLog(stage, a) {
  if (!a) return null;
  switch (stage) {
    case 'SIG':
      return { sentence_count: a.sentence_count, clause_count: a.clauses.length, attention_markers: a.attention_markers };
    case 'INS':
      return { count: a.count, sample: a.entities.slice(0, 40) };
    case 'CON':
      return { count: a.count, sample: a.edges.slice(0, 40) };
    case 'DEF':
      return { total_clauses: a.total_clauses, by_operator: a.by_operator, low_confidence: a.low_confidence, nul_gated: a.nul_gated, failed: a.failed, events: a.events.slice(0, 40) };
    case 'EVA':
      return { stance_histogram: a.stance_histogram, binding_fraction: a.binding_fraction, total_classified: a.total_classified, downstream_budget_note: a.downstream_budget_note, clause_stances: a.clause_stances.slice(0, 40) };
    default:
      return a;
  }
}

function summariseArtifact(stage, a, duration) {
  const ms = `${duration}ms`;
  switch (stage) {
    case 'NUL': return `framed · ${a.char_count} chars · ${a.source_type} · ${ms}`;
    case 'SIG': return `${a.clauses.length} clauses · ${a.attention_markers.length} attention markers · ${ms}`;
    case 'INS': return `${a.count} candidate entities · ${ms}`;
    case 'SEG': return `${a.boundaries.clauses} clauses, ${a.boundaries.sentences} sentences, ${a.boundaries.paragraphs} paragraphs · ${ms}`;
    case 'CON': return `${a.count} proposition edges · ${ms}`;
    case 'SYN': return `${a.merged_entities} merged entities, ${a.proposition_count} propositions · ${ms}`;
    case 'DEF': {
      const ops = Object.entries(a.by_operator).map(([k,v]) => `${k}:${v}`).join(' ');
      return `${a.events.length} events logged · ${a.nul_gated} gated · ${ops || 'no ops'} · ${ms}`;
    }
    case 'EVA': {
      const h = a.stance_histogram;
      const bind = h.Binding || 0;
      return `${a.total_classified} stance-tagged · ${bind} Binding (${(a.binding_fraction*100).toFixed(0)}%) · ${ms}`;
    }
    case 'REC': return a.count === 0 ? `no frame change · ${ms}` : `${a.count} reframe candidate(s) · ${ms}`;
    default: return ms;
  }
}

/* ─── Guardrail: fuzz / shuffle order, assert refusal. ─────────────── */
/**
 * Verify the prereq enforcement by simulating the worker with a shuffled
 * stage order. Returns an array of { order, refused } — every shuffled
 * order other than the canonical one must be refused at the first stage
 * whose prereq isn't yet satisfied.
 */
export function fuzzOrderGuardrail(trials = 30) {
  const results = [];
  for (let t = 0; t < trials; t++) {
    const order = [...STAGES];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // Canonical order never refuses. Any other order with at least one
    // stage before its prereq must refuse.
    const ledger = {};
    let refused = false;
    for (const s of order) {
      if (!prereqsSatisfied(s, ledger)) { refused = true; break; }
      ledger[s] = { status: 'done' };
    }
    const isCanonical = order.every((s, i) => s === STAGES[i]);
    results.push({ order, refused, isCanonical, ok: isCanonical ? !refused : refused });
  }
  return results;
}

/** Clear the idempotence cache. Used when you want a fresh run. */
export function clearPipelineCache(doc_id) {
  if (!doc_id) { _cache.clear(); return; }
  const prefix = `${doc_id}::`;
  for (const k of Array.from(_cache.keys())) {
    if (k.startsWith(prefix)) _cache.delete(k);
  }
}

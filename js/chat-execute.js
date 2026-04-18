// ══════════════════════════════════════════════════════════════════════
// chat-execute.js — walk the operator tree, execute against the store
//
// Each tree node returns an ExecResult:
//   { ok, op, events?, anchors?, edges?, nul?, cost, notes, children? }
//
// NUL propagation: any NUL-leaf bubbles up as `nul` on the parent,
// with the parent deciding whether to swallow it (and produce a partial
// answer) or propagate further. Upstream renderers treat a root-level
// NUL as the honest answer "no transformation requested" or "nothing
// to report".
// ══════════════════════════════════════════════════════════════════════

import { getEvents, appendEvent, upsertAnchor, updateMetrics, getMetrics } from './store.js';
import { makeAnchor, uuidv7 } from './anchor.js';
import { ingest } from './intake.js';
import { findConflicts } from './horizon.js';
import { tryRules } from './rules.js';
import { OPS, opCodeOf, siteFor, resolutionFor, siteCode, resolutionCode } from './ops.js';
import { adjudicateSUP, hasApiKey, extractArgs, summarize } from './model.js';

const TREE_DEPTH_LIMIT = 8;

/** Execute a compiled tree. Returns the root result plus the full cost record. */
export async function execute(tree, { depth = 0, budget = { events_scanned: 0, tokens: 0, model_calls: 0 } } = {}) {
  if (depth > TREE_DEPTH_LIMIT) return { ok: false, op: tree?.op, nul: { reason: 'depth_exceeded' }, cost: budget };
  if (!tree) return { ok: true, op: null, nul: { reason: 'empty_tree' }, cost: budget };

  switch (tree.op) {
    case 'NUL': return execNUL(tree, budget);
    case 'INS': return execINS(tree, budget, depth);
    case 'SEG': return execSEG(tree, budget, depth);
    case 'CON': return execCON(tree, budget, depth);
    case 'SYN': return execSYN(tree, budget, depth);
    case 'ALT': return execALT(tree, budget, depth);
    case 'SUP': return execSUP(tree, budget, depth);
    case 'REC': return execREC(tree, budget, depth);
    default:    return { ok: false, op: tree.op, nul: { reason: 'unknown_op' }, cost: budget };
  }
}

/* ═══ NUL ════════════════════════════════════════════════════════════ */

function execNUL(tree, budget) {
  return {
    ok: true,
    op: 'NUL',
    nul: { reason: tree.reason || 'no_transform', ref: tree.ref || null },
    notes: tree.reason === 'chitchat' ? 'Acknowledge, do not log.'
         : tree.reason === 'unclassified' ? 'Could not parse a request.'
         : 'Nothing to transform.',
    cost: budget
  };
}

/* ═══ INS ════════════════════════════════════════════════════════════
   INS at the chat level means "user is stating facts — run the intake
   pipeline on the content."
   ═══════════════════════════════════════════════════════════════════ */

async function execINS(tree, budget, depth) {
  const leaf = tree.operand;
  if (!leaf || leaf.kind !== 'clause') {
    return { ok: false, op: 'INS', nul: { reason: 'ins_requires_clause' }, cost: budget };
  }
  const results = await ingest(leaf.value, { frame: 'default', agent: 'user' });
  const emitted = results.filter(r => r.status === 'emitted' || r.status === 'low_confidence');
  const gated = results.filter(r => r.status === 'nul_gated');
  const failed = results.filter(r => r.status === 'error' || r.status === 'model_failed');
  // Collect metrics delta
  const metricsAfter = await getMetrics();
  return {
    ok: true,
    op: 'INS',
    events: emitted.map(r => r.event),
    notes: `Ingested ${emitted.length} event${emitted.length===1?'':'s'}${gated.length?`, ${gated.length} NUL-gated`:''}${failed.length?`, ${failed.length} failed`:''}`,
    cost: budget,
    children: [{ op: 'clause', leaf: truncate(leaf.value, 80) }]
  };
}

/* ═══ SEG — scoping / filtering / partitioning ═════════════════════════
   SEG tree shapes we support:
     SEG(anchor)             → events with target = anchor
     SEG(anchor, time)       → narrowed by time range
     SEG(SEG(...), topic)    → further narrowed by text
     SEG(null, time)         → events in a time range
     SEG(null, text)         → text search
     SEG(null, null)         → recent window
   ═══════════════════════════════════════════════════════════════════ */

async function execSEG(tree, budget, depth) {
  const filter = await buildFilterFromTree(tree);
  if (filter.nul) return { ok: true, op: 'SEG', nul: filter.nul, cost: budget };

  const events = await getEvents(filter);
  budget.events_scanned += events.length;
  return {
    ok: true,
    op: 'SEG',
    events,
    filter,
    nul: events.length === 0 ? { reason: 'empty_result', filter } : null,
    notes: `${events.length} event${events.length===1?'':'s'} matched`,
    cost: budget
  };
}

/** Flatten a nested SEG tree into a single filter object. */
async function buildFilterFromTree(tree) {
  const filter = { limit: 200 };
  const collect = async (node) => {
    if (!node) return;
    if (node.op === 'SEG') {
      await collect(node.operand);
      await applyContext(filter, node.context);
    } else if (node.op === 'NUL') {
      filter.nul = { reason: node.reason, ref: node.ref };
    } else if (node.kind === 'anchor') {
      const a = makeAnchor(node.name);
      await upsertAnchor({ hash: a.hash, form: a.form, original: a.original, type_hint: 'Entity' });
      filter.target = a.hash;
      filter._target_form = a.form;
      filter._target_name = node.name;
    } else if (node.kind === 'list') {
      // Multi-anchor SEG — store a list, applied post-hoc
      filter._target_list = node.items.filter(i => i.kind === 'anchor').map(i => makeAnchor(i.name).hash);
    } else if (node.kind === 'time') {
      filter.from = node.from || filter.from;
      filter.to = node.to || filter.to;
      filter._time_label = node.label;
    } else if (node.kind === 'text') {
      filter.text = node.value;
    }
  };
  await collect(tree);
  return filter;
}

async function applyContext(filter, ctx) {
  if (!ctx) return;
  if (ctx.kind === 'time') {
    if (ctx.from) filter.from = ctx.from;
    if (ctx.to) filter.to = ctx.to;
    if (ctx.label) filter._time_label = ctx.label;
  } else if (ctx.kind === 'text') {
    filter.text = filter.text ? `${filter.text} ${ctx.value}` : ctx.value;
  }
}

/* ═══ CON — relationship / graph traversal ═════════════════════════════
   CON(anchor, other) → edges from anchor (optionally filtered by other)
   CON(anchor, text)  → edges from anchor where relation/predicate contains text
   ═══════════════════════════════════════════════════════════════════ */

async function execCON(tree, budget, depth) {
  const primary = tree.operand;
  if (!primary || primary.kind !== 'anchor') {
    return { ok: true, op: 'CON', nul: { reason: 'con_requires_anchor' }, cost: budget };
  }
  const a = makeAnchor(primary.name);
  // Query events where target = anchor AND op_code = CON
  const events = await getEvents({ target: a.hash, op_code: 5 /* CON */, limit: 200 });
  budget.events_scanned += events.length;

  const related = events.map(e => ({
    event: e,
    relation: e.spo?.p || '(linked)',
    to_form: e.operand || e.spo?.o || '?',
    ts: e.ts
  }));
  return {
    ok: true,
    op: 'CON',
    anchor: { name: primary.name, hash: a.hash },
    edges: related,
    events,
    nul: related.length === 0 ? { reason: 'no_connections', anchor: primary.name } : null,
    notes: `${related.length} connection${related.length===1?'':'s'} from ${primary.name}`,
    cost: budget
  };
}

/* ═══ SYN — synthesis (may invoke the model) ════════════════════════════ */

async function execSYN(tree, budget, depth) {
  const inner = await execute(tree.operand, { depth: depth + 1, budget });
  if (inner.nul && !inner.events?.length) {
    return { ok: true, op: 'SYN', nul: { reason: 'nothing_to_synthesize', inner_nul: inner.nul }, inner, cost: budget };
  }
  const events = inner.events || [];
  if (!events.length) {
    return { ok: true, op: 'SYN', nul: { reason: 'empty_set' }, inner, cost: budget };
  }
  // If the model is available, ask it for a summary; else return a template summary
  let synthesis;
  if (hasApiKey()) {
    synthesis = await synthesizeViaModel(events, tree, budget);
  } else {
    synthesis = synthesizeTemplate(events, tree);
  }
  return {
    ok: true,
    op: 'SYN',
    inner,
    synthesis,
    events,
    notes: `Synthesized over ${events.length} event${events.length===1?'':'s'}`,
    cost: budget
  };
}

async function synthesizeViaModel(events, tree, budget) {
  try {
    const directive = tree.context?.value === 'judgment'
      ? 'Focus on the decisions, transitions, and evaluations in this set.'
      : 'Summarize the pattern across these events.';
    const r = await summarize({ events, directive, maxTokens: 300 });
    budget.tokens = (budget.tokens || 0) + r.tokensIn + r.tokensOut;
    budget.model_calls = (budget.model_calls || 0) + 1;
    // Also update store metrics so the inspector footer sees the delta
    const { updateMetrics } = await import('./store.js');
    await updateMetrics({
      modelCalls: 1,
      modelTokensIn: r.tokensIn,
      modelTokensOut: r.tokensOut
    });
    return r.text;
  } catch(e) {
    // Fall back to template if the model is unreachable or the key's bad
    return synthesizeTemplate(events, tree) + `\n\n(Model summary unavailable: ${e.message || e.code || 'error'}. Showing structural summary instead.)`;
  }
}

function synthesizeTemplate(events, tree) {
  // Group by operator
  const byOp = {};
  for (const e of events) byOp[e.operator] = (byOp[e.operator] || 0) + 1;
  const parts = Object.entries(byOp).sort(([,a],[,b]) => b-a).map(([op, n]) => `${n} ${op}`);
  const timeRange = events.length
    ? `from ${events[events.length-1].ts?.slice(0,10)} to ${events[0].ts?.slice(0,10)}`
    : '';
  return `${events.length} events ${timeRange}: ${parts.join(' · ')}. Dominant activity: ${Object.entries(byOp).sort(([,a],[,b]) => b-a)[0]?.[0] || '—'}.`;
}

/* ═══ ALT — assert a value within the frame ═══════════════════════════
   ALT(anchor:X, text:"value") → logs an ALT event stating a value for X
   ═══════════════════════════════════════════════════════════════════ */

async function execALT(tree, budget, depth) {
  const term = tree.operand;
  const meaning = tree.context;
  if (!term || term.kind !== 'anchor') {
    return { ok: true, op: 'ALT', nul: { reason: 'alt_requires_term' }, cost: budget };
  }
  const a = makeAnchor(term.name);
  await upsertAnchor({ hash: a.hash, form: a.form, original: a.original, type_hint: 'Entity' });
  const mode = 'Differentiating', domain = 'Significance', object = 'Entity';
  const site = siteFor(domain, object);
  const res = resolutionFor(mode, object);
  const event = {
    uuid: uuidv7(),
    ts: new Date().toISOString(),
    op_code: 7,
    operator: 'ALT',
    target: a.hash,
    target_form: a.form,
    operand: meaning?.value || null,
    spo: { s: 'user', p: 'asserts', o: meaning?.value || '' },
    mode, domain, object,
    site: siteCode(site), site_name: site,
    resolution: resolutionCode(res), resolution_name: res,
    frame: 'default', agent: 'user',
    clause: `ALT: ${term.name} = "${meaning?.value || ''}"`,
    confidence: 1.0,
    rationale: 'User-asserted value from chat',
    provenance: { source: 'chat', path: 'alt' }
  };
  await appendEvent(event);
  return {
    ok: true,
    op: 'ALT',
    events: [event],
    notes: `Asserted "${term.name}"`,
    cost: budget
  };
}

/* ═══ SUP — hold/reconcile contradictions ══════════════════════════════
   SUP over a SEG-inner: narrow down to superposed values in that scope
   SUP with no inner: find all open superpositions
   ═══════════════════════════════════════════════════════════════════ */

async function execSUP(tree, budget, depth) {
  // Execute inner to get candidate events (or, if inner is null, use full conflict scan)
  let scopeEvents = [];
  if (tree.operand) {
    const inner = await execute(tree.operand, { depth: depth + 1, budget });
    scopeEvents = inner.events || [];
  }

  // Find open conflicts — intersect with scope if one was provided
  const conflicts = await findConflicts();
  const scopeTargets = new Set(scopeEvents.map(e => e.target));
  const relevant = tree.operand
    ? conflicts.filter(c => scopeTargets.has(c.target) && !c.resolved)
    : conflicts.filter(c => !c.resolved);

  if (!relevant.length) {
    return {
      ok: true,
      op: 'SUP',
      nul: { reason: 'no_conflicts_in_scope' },
      cost: budget,
      notes: 'No open ALT superpositions in scope.'
    };
  }

  // For each conflict, try rules first
  const adjudications = [];
  for (const c of relevant) {
    const ruleResult = await tryRules({ hash: c.target, form: c.target_form }, c.candidates);
    if (ruleResult) {
      // Rule matched — write the SUP event now so the conflict is actually closed
      const winner = c.candidates[ruleResult.winnerIndex];
      await appendEvent({
        uuid: uuidv7(),
        ts: new Date().toISOString(),
        op_code: 8,
        operator: 'SUP',
        target: c.target,
        target_form: c.target_form,
        operand: winner.value,
        spo: { s: 'rule', p: 'adjudicated', o: String(winner.value) },
        mode: 'Relating', domain: 'Significance', object: 'Entity',
        site: 8, site_name: 'Lens',
        resolution: 5, resolution_name: 'Binding',
        frame: 'default',
        agent: 'rule',
        clause: `Rule ${ruleResult.ruleStrategy} resolved: ${JSON.stringify(winner.value)}`,
        confidence: ruleResult.confidence || 1.0,
        rationale: ruleResult.reason,
        provenance: { source: 'rule', rule_id: ruleResult.ruleId, path: 'sup' }
      });
      await updateMetrics({ conflictsAdjudicated: 1 });
    }
    adjudications.push({
      target: c.target_form,
      target_hash: c.target,
      candidates: c.candidates,
      resolution: ruleResult,
      needs_user: !ruleResult
    });
  }
  return {
    ok: true,
    op: 'SUP',
    adjudications,
    notes: `${relevant.length} conflict${relevant.length===1?'':'s'} in scope · ${adjudications.filter(a => a.resolution).length} resolvable by rule`,
    cost: budget
  };
}

/* ═══ REC — frame restructuring proposal ═══════════════════════════════ */

async function execREC(tree, budget, depth) {
  // Chat-triggered REC: emit a proposal event for the fold/UI to pick up
  const clause = tree.operand?.value || '';
  return {
    ok: true,
    op: 'REC',
    notes: 'Frame-change proposal surfaced — review in the Inspector REC panel.',
    proposal: {
      source: 'chat',
      clause,
      ts: new Date().toISOString()
    },
    cost: budget
  };
}

/* ═══ Utilities ══════════════════════════════════════════════════════ */

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n-1) + '…' : str;
}

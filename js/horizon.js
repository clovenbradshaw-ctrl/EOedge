// ══════════════════════════════════════════════════════════════════════
// horizon.js — the read layer
//
// Horizon is deterministic projection over the append-only events store.
// Every query is a CPU scan using the best-matching IndexedDB index,
// with residual predicates applied in a tight typed loop.
//
// No model calls. No network. Metrics count each call toward the
// "Horizon queries" counter — these are what would have been model
// calls in a conventional RAG-style system.
// ══════════════════════════════════════════════════════════════════════

import { getEvents, updateMetrics } from './store.js';
import { OPS, OP_ORDER, SITE_ORDER, RESOLUTION_ORDER, OBJECT_ORDER, DESERT_CELL,
         opCodeOf, siteCode, resolutionCode, siteFor, resolutionFor } from './ops.js';

/**
 * Project — the primary query function.
 * Accepts any combination of:
 *   operator:    string ('NUL', 'CON', etc.) or null
 *   object:      'Ground' | 'Figure' | 'Pattern' | null
 *   site:        site name ('Void', 'Entity', ...) or null
 *   resolution:  stance name ('Clearing', 'Binding', ...) or null
 *   target:      anchor hash or null
 *   frame:       frame hash or null
 *   from, to:    ISO timestamps (inclusive range) or null
 *   text:        substring search over clause/form/spo (optional)
 *   limit:       max events (default: 500)
 *
 * Returns { events, count, cell_counts } where cell_counts summarizes
 * the full 27-cell distribution for the result set.
 */
export async function project(filter = {}) {
  // Translate operator/object/site/resolution into store-level codes
  const f = {};
  if (filter.operator) f.op_code = opCodeOf(filter.operator);
  if (filter.site) f.site = siteCode(filter.site);
  if (filter.resolution) f.resolution = resolutionCode(filter.resolution);
  if (filter.target) f.target = filter.target;
  if (filter.frame) f.frame = filter.frame;
  if (filter.from) f.from = filter.from;
  if (filter.to) f.to = filter.to;

  let events = await getEvents(f);

  // Residual predicates: object and text are not indexed
  if (filter.object) {
    events = events.filter(e => e.object === filter.object);
  }
  if (filter.text) {
    const q = filter.text.toLowerCase();
    events = events.filter(e => {
      const hay = `${e.clause} ${e.target_form || ''} ${e.spo?.s || ''} ${e.spo?.p || ''} ${e.spo?.o || ''} ${e.operand || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  // Sort by timestamp descending (most recent first) — IndexedDB doesn't
  // guarantee this from non-ts indexes.
  events.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

  const limit = filter.limit || 500;
  const truncated = events.length > limit;
  const out = events.slice(0, limit);

  // Count as one horizon query for metrics (unless the caller opted out)
  if (!filter._silent) await updateMetrics({ horizonQueries: 1 });

  return {
    events: out,
    count: events.length,
    truncated,
    cell_counts: cellCounts(events)
  };
}

/** Count events per (operator, object) cell for grid rendering. */
export function cellCounts(events) {
  const counts = {};
  for (const op of OP_ORDER) {
    for (const obj of OBJECT_ORDER) counts[`${op}|${obj}`] = 0;
  }
  for (const e of events) {
    const key = `${e.operator}|${e.object}`;
    if (key in counts) counts[key] += 1;
  }
  return counts;
}

/** Count events per Act-face cell (Mode × Domain = the nine operators). */
export async function actFaceCounts(filter = {}) {
  const { events } = await project({ ...filter, _silent: true, limit: 1e9 });
  const counts = Object.fromEntries(OP_ORDER.map(op => [op, 0]));
  for (const e of events) counts[e.operator] = (counts[e.operator] || 0) + 1;
  return counts;
}

/** Count events per Site-face cell (Domain × Object). */
export async function siteFaceCounts(filter = {}) {
  const { events } = await project({ ...filter, _silent: true, limit: 1e9 });
  const counts = Object.fromEntries(SITE_ORDER.map(s => [s, 0]));
  for (const e of events) {
    const site = e.site_name || siteFor(e.domain, e.object);
    if (site in counts) counts[site] += 1;
  }
  return counts;
}

/** Count events per Resolution-face cell (Mode × Object). */
export async function resolutionFaceCounts(filter = {}) {
  const { events } = await project({ ...filter, _silent: true, limit: 1e9 });
  const counts = Object.fromEntries(RESOLUTION_ORDER.map(r => [r, 0]));
  for (const e of events) {
    const r = e.resolution_name || resolutionFor(e.mode, e.object);
    if (r in counts) counts[r] += 1;
  }
  return counts;
}

/**
 * Detect DEF conflicts: targets that have multiple DEF events with
 * different operand values, with no subsequent superseding EVA by an
 * agent-level actor.
 */
export async function findConflicts() {
  const { events: defs } = await project({ operator: 'DEF', _silent: true, limit: 1e9 });
  // Group by target anchor
  const byTarget = new Map();
  for (const e of defs) {
    if (!byTarget.has(e.target)) byTarget.set(e.target, []);
    byTarget.get(e.target).push(e);
  }
  // Also fetch EVAs to find which conflicts have been resolved
  const { events: evas } = await project({ operator: 'EVA', _silent: true, limit: 1e9 });
  const resolvedTargets = new Set();
  for (const e of evas) {
    if (e.agent === 'user' || e.agent === 'rule') resolvedTargets.add(e.target);
  }

  const conflicts = [];
  for (const [target, defEvents] of byTarget.entries()) {
    if (defEvents.length < 2) continue;
    // Check if all operand values are the same — if so, no conflict
    const operands = new Set(defEvents.map(d => JSON.stringify(d.operand)));
    if (operands.size < 2) continue;
    conflicts.push({
      target,
      target_form: defEvents[0].target_form,
      candidates: defEvents.map(d => ({
        value: d.operand,
        source: d.agent,
        timestamp: d.ts,
        provenance: d.provenance,
        event_uuid: d.uuid
      })).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || '')),
      resolved: resolvedTargets.has(target)
    });
  }
  return conflicts;
}

/**
 * Summary statistics for the footer: totals and op distribution.
 */
export async function summary() {
  const { events } = await project({ _silent: true, limit: 1e9 });
  const opCounts = Object.fromEntries(OP_ORDER.map(op => [op, 0]));
  const objCounts = { Ground: 0, Figure: 0, Pattern: 0 };
  let latestTs = '';
  for (const e of events) {
    opCounts[e.operator] = (opCounts[e.operator] || 0) + 1;
    if (e.object in objCounts) objCounts[e.object] += 1;
    if (e.ts && e.ts > latestTs) latestTs = e.ts;
  }
  return {
    total: events.length,
    opCounts,
    objCounts,
    latestTs,
    cellCounts: cellCounts(events)
  };
}

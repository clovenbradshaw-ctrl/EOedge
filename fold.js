// ══════════════════════════════════════════════════════════════════════
// fold.js — background pattern detector for REC proposals
//
// Spec §8 calls for a Web Worker. v1 runs on the main thread via
// requestIdleCallback — simpler and sufficient at prototype scale.
// The public surface (start/stop, proposals listener) is Worker-ready
// so v2 can move the heavy scan to a real Worker without touching UI code.
//
// What it does:
//   • Scans the events store periodically
//   • Detects conflict rate by target type
//   • Detects resolution convergence (repeated user EVAs pointing the same way)
//   • Emits REC proposals through onProposal callback
// ══════════════════════════════════════════════════════════════════════

import { getEvents, subscribe, updateMetrics } from './store.js';
import { OP_ORDER } from './ops.js';

const CONFLICT_THRESHOLD = 0.3;   // DEF-to-clean ratio
const MIN_EVENTS_PER_CLASS = 4;   // don't fire on tiny samples
const CONVERGENCE_MIN = 3;        // at least 3 user EVAs in the same direction
const SCAN_INTERVAL_MS = 45000;   // 45 seconds when idle

let _running = false;
let _timer = null;
let _onProposal = null;
let _lastScanProposalIds = new Set();

/** Start the fold scheduler. onProposal(proposal) is called for each REC proposal. */
export function start(onProposal) {
  if (_running) return;
  _running = true;
  _onProposal = onProposal;
  scheduleScan(5000);
  // Re-scan when new events arrive (debounced via timer)
  subscribe((kind) => {
    if (kind === 'event' && _running) scheduleScan(15000);
  });
}

export function stop() {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

function scheduleScan(delay) {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(runScan, delay);
}

async function runScan() {
  if (!_running) return;
  try {
    const proposals = [];
    await detectConflictRate(proposals);
    await detectResolutionConvergence(proposals);
    await updateMetrics({ foldWorkerRuns: 1 });
    for (const p of proposals) {
      if (_lastScanProposalIds.has(p.id)) continue;
      _lastScanProposalIds.add(p.id);
      if (_onProposal) _onProposal(p);
    }
  } catch(e) {
    console.warn('Fold scan error:', e);
  }
  scheduleScan(SCAN_INTERVAL_MS);
}

/* ═══ Detector 1: conflict rate ═══════════════════════════════════════
   If a class of targets has a DEF-to-total ratio above threshold, the
   frame is probably inadequate — propose a REC.
   ═══════════════════════════════════════════════════════════════════ */
async function detectConflictRate(proposals) {
  const defs = await getEvents({ op_code: 7 }); // DEF
  const allEvents = await getEvents({});
  // Group by target type_hint (derived from the event)
  const byClass = new Map();
  for (const e of allEvents) {
    const cls = e.type_hint || e.object || 'default';
    if (!byClass.has(cls)) byClass.set(cls, { total: 0, defs: 0, samples: [] });
    const c = byClass.get(cls);
    c.total += 1;
    if (e.op_code === 7) { c.defs += 1; c.samples.push(e); }
  }
  for (const [cls, stats] of byClass.entries()) {
    if (stats.total < MIN_EVENTS_PER_CLASS) continue;
    const ratio = stats.defs / stats.total;
    if (ratio >= CONFLICT_THRESHOLD) {
      proposals.push({
        id: `conflict-rate:${cls}:${Math.floor(Date.now()/60000)}`, // minute-bucket id
        kind: 'conflict-rate',
        target_class: cls,
        observed_ratio: +ratio.toFixed(2),
        threshold: CONFLICT_THRESHOLD,
        sample_size: stats.total,
        def_count: stats.defs,
        suggestion: `Targets of type "${cls}" show a sustained DEF-to-total ratio of ${(ratio*100).toFixed(0)}% (over ${stats.total} events). The current frame may not be distinguishing the values that are producing conflicts. Consider a REC proposal to introduce a distinguishing dimension.`,
        created_at: new Date().toISOString()
      });
    }
  }
}

/* ═══ Detector 2: resolution convergence ═══════════════════════════════
   If a user's EVA choices consistently go the same way for a class of
   targets, propose installing a deterministic rule.
   ═══════════════════════════════════════════════════════════════════ */
async function detectResolutionConvergence(proposals) {
  const evas = await getEvents({ op_code: 8 });
  const userEvas = evas.filter(e => e.agent === 'user');
  if (userEvas.length < CONVERGENCE_MIN) return;

  // For each class, look at how user resolved conflicts
  const byClass = new Map();
  for (const e of userEvas) {
    // The EVA operand should indicate which value won, via provenance or the chosen value
    const cls = e.type_hint || e.object || 'default';
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(e);
  }

  for (const [cls, items] of byClass.entries()) {
    if (items.length < CONVERGENCE_MIN) continue;

    // Did the user consistently pick the "latest" value? Check the winner's
    // timestamp rank among candidates recorded in provenance.
    const latestWinCount = items.filter(e => e.provenance?.pattern === 'latest-wins').length;
    const confidenceWinCount = items.filter(e => e.provenance?.pattern === 'highest-confidence').length;

    const total = items.length;
    if (latestWinCount / total >= 0.75) {
      proposals.push({
        id: `convergence:latest:${cls}:${Math.floor(Date.now()/3600000)}`,
        kind: 'convergence',
        target_class: cls,
        pattern: 'latest-wins',
        sample_size: total,
        hit_rate: +(latestWinCount / total).toFixed(2),
        suggestion: `For targets of type "${cls}", the user has picked the latest value in ${latestWinCount} of ${total} conflicts (${Math.round(latestWinCount/total*100)}%). Installing a 'latest-wins' rule would resolve future conflicts of this shape deterministically, without invoking the model.`,
        rule_proposal: {
          strategy: 'latestWins',
          match: { type_hint: cls },
          config: {},
          priority: 10,
          description: `latest-wins for ${cls} (auto-detected)`
        },
        created_at: new Date().toISOString()
      });
    } else if (confidenceWinCount / total >= 0.75) {
      proposals.push({
        id: `convergence:confidence:${cls}:${Math.floor(Date.now()/3600000)}`,
        kind: 'convergence',
        target_class: cls,
        pattern: 'highest-confidence',
        sample_size: total,
        hit_rate: +(confidenceWinCount / total).toFixed(2),
        suggestion: `For targets of type "${cls}", the user has picked the highest-confidence source in ${confidenceWinCount} of ${total} conflicts.`,
        rule_proposal: {
          strategy: 'highestConfidence',
          match: { type_hint: cls },
          config: {},
          priority: 10,
          description: `highest-confidence for ${cls} (auto-detected)`
        },
        created_at: new Date().toISOString()
      });
    }
  }
}

/** Force-run a scan synchronously — useful for UI "refresh" actions. */
export async function runNow() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  await runScan();
}

/** Clear the dedupe set so previously-seen proposals are re-emitted. */
export function resetProposalHistory() {
  _lastScanProposalIds.clear();
}

// ══════════════════════════════════════════════════════════════════════
// seeds.js — pre-classified events so the app works without API calls
// ══════════════════════════════════════════════════════════════════════

import { OPS, siteFor, resolutionFor, siteCode, resolutionCode, opCodeOf } from './ops.js';
import { makeAnchor, uuidv7 } from './anchor.js';
import { appendEvents, upsertAnchor, appendEdge } from './store.js';

const SEEDS = [
  {
    clause: "Maria closed James's mental-health referral.",
    spo: { s: "Maria", p: "closed", o: "James's mental-health referral" },
    operator: "NUL",  // NUL doesn't emit — loadSeeds converts to ALT(inactive) since an observable transition happened
    mode: "Relating", domain: "Significance", object: "Entity",
    operand: "inactive",
    confidence: 0.84,
    rationale: "Referral status transitions from open to closed — a value move within the case-status frame."
  },
  {
    clause: "Dr. Chen registered a new patient in the intake system.",
    spo: { s: "Dr. Chen", p: "registered", o: "a new patient" },
    operator: "INS",
    mode: "Generating", domain: "Existence", object: "Entity",
    operand: "new patient record",
    confidence: 0.94,
    rationale: "A specific patient crosses from potential to actual; a new permanent anchor is minted."
  },
  {
    clause: "The team split the caseload by district.",
    spo: { s: "The team", p: "split", o: "the caseload" },
    operator: "SEG",
    mode: "Differentiating", domain: "Structure", object: "Condition",
    operand: "by district",
    confidence: 0.91,
    rationale: "A collection is partitioned along a dimension; boundaries drawn over existing terrain."
  },
  {
    clause: "The housing program linked each client with an assigned caseworker.",
    spo: { s: "The housing program", p: "linked", o: "each client with an assigned caseworker" },
    operator: "CON",
    mode: "Relating", domain: "Structure", object: "Entity",
    operand: "assigned caseworker",
    confidence: 0.93,
    rationale: "A relationship is established between two differentiated entity classes."
  },
  {
    clause: "The quarterly review consolidated all three regional reports into one narrative.",
    spo: { s: "The quarterly review", p: "consolidated", o: "all three regional reports" },
    operator: "SYN",
    mode: "Generating", domain: "Structure", object: "Pattern",
    operand: "consolidated narrative",
    confidence: 0.89,
    rationale: "Parts integrate into a whole that exceeds their sum — emergent configuration."
  },
  {
    clause: "The CRM's Q3 revenue is $4.2M.",
    spo: { s: "The CRM", p: "reports", o: "Q3 revenue of $4.2M" },
    operator: "ALT",
    mode: "Differentiating", domain: "Significance", object: "Entity",
    operand: "4.2M",
    confidence: 0.88,
    agent: "source:crm",
    rationale: "A value is asserted for Q3 revenue under the CRM frame — one alternative among possible values."
  },
  {
    clause: "The finance team's manual count puts Q3 revenue at $3.9M.",
    spo: { s: "The finance team", p: "counts", o: "Q3 revenue at $3.9M" },
    operator: "SUP",
    mode: "Relating", domain: "Significance", object: "Entity",
    operand: "3.9M",
    confidence: 0.86,
    agent: "source:manual",
    rationale: "A competing value is held for the same target under the manual-count frame. Superposition — both held simultaneously."
  },
  {
    clause: "The intake form status moved from pending to active.",
    spo: { s: "The intake form status", p: "moved", o: "from pending to active" },
    operator: "ALT",
    mode: "Differentiating", domain: "Significance", object: "Entity",
    operand: "active",
    confidence: 0.88,
    rationale: "Value changes within the case-status frame — alternation between pending and active."
  },
  {
    clause: "The department restructured its client classification from two tiers into five.",
    spo: { s: "The department", p: "restructured", o: "its client classification" },
    operator: "REC",
    mode: "Generating", domain: "Significance", object: "Pattern",
    operand: "5-tier classification",
    confidence: 0.95,
    rationale: "The classificatory frame itself is reorganized — schema migration, not a value change within the old frame."
  },
  {
    clause: "The new bylaw applies to every nonprofit operating in the district.",
    spo: { s: "The new bylaw", p: "applies to", o: "every nonprofit operating in the district" },
    operator: "CON",
    mode: "Relating", domain: "Structure", object: "Pattern",
    operand: "nonprofits in district",
    confidence: 0.82,
    rationale: "A structural relationship is established between a rule and a class of entities."
  },
  {
    clause: "The quarterly review consolidated regional reports into a single narrative.",
    spo: { s: "The quarterly review", p: "consolidated", o: "regional reports" },
    operator: "SYN",
    mode: "Generating", domain: "Structure", object: "Pattern",
    operand: "consolidated narrative",
    confidence: 0.86,
    rationale: "Parts integrate into a whole — emergent configuration across the regional set."
  },
  {
    clause: "Maria reclassified the case from housing support to crisis intervention.",
    spo: { s: "Maria", p: "reclassified", o: "the case" },
    operator: "REC",
    mode: "Generating", domain: "Significance", object: "Entity",
    operand: "crisis intervention",
    confidence: 0.79,
    rationale: "The interpretive frame under which the case is held is itself changed — not a value change but a schema shift for this case."
  }
];

/**
 * Load seed events into the store. Anchors and edges are materialized
 * so the UI reflects the seed data as if it had come through the pipeline.
 */
export async function loadSeeds({ frame = 'default' } = {}) {
  const now = Date.now();
  const events = [];
  const anchorSeen = new Set();

  for (let i = 0; i < SEEDS.length; i++) {
    const s = SEEDS[i];
    // Convert the NUL seed into an ALT (since NUL never emits)
    const op = s.operator === 'NUL' ? 'ALT' : s.operator;
    const opData = OPS[op];
    if (!opData) continue;

    const target = s.spo?.o || s.spo?.s || s.clause.slice(0, 60);
    const anchor = makeAnchor(target);
    if (!anchorSeen.has(anchor.hash)) {
      await upsertAnchor({
        hash: anchor.hash,
        form: anchor.form,
        original: anchor.original,
        type_hint: s.object === 'Condition' ? 'Field' : s.object === 'Pattern' ? 'Paradigm' : 'Entity'
      });
      anchorSeen.add(anchor.hash);
    }

    const event = {
      uuid: uuidv7(),
      ts: new Date(now - (SEEDS.length - i) * 1800_000).toISOString(),
      op_code: opCodeOf(op),
      operator: op,
      target: anchor.hash,
      target_form: anchor.form,
      operand: s.operand || null,
      spo: s.spo,
      mode: s.mode,
      domain: s.domain,
      object: s.object,
      site: siteCode(siteFor(s.domain, s.object)),
      site_name: siteFor(s.domain, s.object),
      resolution: resolutionCode(resolutionFor(s.mode, s.object)),
      resolution_name: resolutionFor(s.mode, s.object),
      frame,
      agent: s.agent || 'seed',
      clause: s.clause,
      confidence: s.confidence,
      rationale: s.rationale,
      provenance: { source: 'seed', path: 'seed' }
    };
    events.push(event);

    if (op === 'CON' && s.operand) {
      const ta = makeAnchor(s.operand);
      if (!anchorSeen.has(ta.hash)) {
        await upsertAnchor({ hash: ta.hash, form: ta.form, original: ta.original, type_hint: 'Entity' });
        anchorSeen.add(ta.hash);
      }
      await appendEdge({
        source: anchor.hash,
        target: ta.hash,
        relation: (s.spo?.p || 'related').toLowerCase(),
        event: event.uuid
      });
    }
  }

  await appendEvents(events);
  return events.length;
}

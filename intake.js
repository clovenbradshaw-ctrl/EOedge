// ══════════════════════════════════════════════════════════════════════
// intake.js — the classification pipeline
//
// The entry point for all content coming into the runtime.
// Steps:
//   1. Split input into clauses (client-side, zero tokens)
//   2. For each clause:
//      a. NUL gate pre-check (heuristic)
//      b. Heuristic classification (zero tokens)
//      c. If ambiguous or low-confidence, fall back to the model
//      d. Resolve target to anchor (INS if new)
//      e. Append event to store
//      f. Materialize CON edges when applicable
//   3. Update metrics
//
// This is the only place where the model is allowed to be invoked from
// the intake path. EVA adjudication and fold-worker pattern detection
// are the only other paths that can call the model.
// ══════════════════════════════════════════════════════════════════════

import { OPS, EMITTING, siteFor, resolutionFor, siteCode, resolutionCode, opCodeOf } from './ops.js';
import { makeAnchor, uuidv7 } from './anchor.js';
import { appendEvent, upsertAnchor, appendEdge, updateMetrics } from './store.js';
import { classifyHeuristic } from './heuristic.js';
import { extractArgs, hasApiKey, ModelError } from './model.js';

/* ═══ Clause splitter ════════════════════════════════════════════════
   Pure client-side splitting. No model involvement. Conjunction-based
   heuristic — good enough for demonstration, imperfect at very long
   compound sentences. If you paste a paragraph, this produces one
   candidate clause per sentence-fragment; the classifier's NUL gate
   will catch any fragments that aren't actually transformations.
   ═══════════════════════════════════════════════════════════════════ */
export function splitIntoClauses(text) {
  if (!text) return [];
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  // First split into sentences
  const sentences = normalized.split(/(?<=[.!?])\s+(?=[A-Z"'(])/);
  const clauses = [];
  for (const s of sentences) {
    const sentence = s.trim();
    if (!sentence) continue;
    // Split coordinated clauses: "X and Y", "X, but Y"
    const parts = sentence.split(/,?\s+(?:and then|then|and|but|however|which|while|after which|before|so that)\s+/i);
    for (const p of parts) {
      const cleaned = p.replace(/^[,;:\s]+|[,;:]+\s*$/g, '').trim();
      if (cleaned && cleaned.split(/\s+/).length >= 3) clauses.push(cleaned);
    }
  }
  // Fallback: if no clauses emerged, use the original text
  return clauses.length ? clauses : [normalized];
}

/* ═══ The pipeline ═══════════════════════════════════════════════════ */

/**
 * Process a single clause through the full pipeline.
 * Returns { event, status, classification }.
 *
 * status values:
 *   'emitted'       — event was written to the log
 *   'nul_gated'     — non-transformation, no event written
 *   'model_failed'  — model fallback failed (no key, error); no event
 *   'low_confidence' — event written but flagged for human EVA
 */
export async function classifyClause(clause, options = {}) {
  const { frame = 'default', agent = 'user', context = '' } = options;
  const c = String(clause || '').trim();
  if (!c) return { status: 'nul_gated', reason: 'empty' };

  // Step 1: heuristic
  const heur = classifyHeuristic(c);
  await updateMetrics({ heuristicCalls: 1 });

  if (heur.nul_gate) {
    await updateMetrics({ nulGates: 1 });
    return { status: 'nul_gated', reason: heur.reason };
  }

  let final;
  let usedModel = false;
  let tokensIn = 0, tokensOut = 0;
  let rationale = heur.rationale || '';

  if (heur.ambiguous || heur.confidence < 0.65) {
    // Step 2: model fallback
    if (!hasApiKey()) {
      // Without a model, fall back to the best heuristic guess if one exists
      if (heur.ambiguous && heur.top?.[0]?.[1] > 0.3) {
        const [bestOp] = heur.top[0];
        final = heuristicToResult(c, heur, bestOp);
        rationale = `Heuristic-only (no model key); picked ${bestOp} from ambiguous top-${heur.top.length}.`;
      } else {
        return { status: 'model_failed', reason: 'no-key-and-no-heuristic-match' };
      }
    } else {
      try {
        const r = await extractArgs(c, context);
        tokensIn = r.tokensIn; tokensOut = r.tokensOut;
        await updateMetrics({ modelCalls: 1, modelTokensIn: tokensIn, modelTokensOut: tokensOut });
        usedModel = true;

        if (r.nul_gate) {
          await updateMetrics({ nulGates: 1 });
          return { status: 'nul_gated', reason: 'model-nul' };
        }
        if (!r.operator || !OPS[r.operator]) {
          return { status: 'model_failed', reason: `unknown operator: ${r.operator}` };
        }
        final = {
          operator: r.operator,
          mode: r.mode || OPS[r.operator].mode,
          domain: r.domain || OPS[r.operator].domain,
          object: r.object || 'Figure',
          spo: r.spo,
          target: r.target || r.spo?.o || r.spo?.s || c,
          operand: r.operand || '',
          confidence: r.confidence || 0.6
        };
        rationale = r.rationale || `Model extraction (confidence ${(r.confidence||0).toFixed(2)})`;
      } catch(e) {
        // If the model fails but we have a low-confidence heuristic, use it
        if (heur.operator) {
          final = heuristicToResult(c, heur, heur.operator);
          rationale = `Heuristic fallback after model error: ${e.message || e.code}`;
        } else {
          return { status: 'model_failed', reason: e.message || String(e) };
        }
      }
    }
  } else {
    // Confident heuristic match — use it
    final = heuristicToResult(c, heur, heur.operator);
  }

  // Step 3: NUL and SIG never emit log entries (§5.1 invariant)
  if (!EMITTING.has(final.operator)) {
    if (final.operator === 'NUL') await updateMetrics({ nulGates: 1 });
    return { status: 'nul_gated', reason: `${final.operator} is non-emitting` };
  }

  // Step 4: resolve target to anchor (INS if new)
  const targetStr = final.target || final.spo?.o || final.spo?.s || c.slice(0, 80);
  const anchor = makeAnchor(targetStr);
  const { created } = await upsertAnchor({
    hash: anchor.hash,
    form: anchor.form,
    original: anchor.original,
    first_seen: null, // set on first event below
    type_hint: inferTypeHint(final.operator, final.object)
  });

  // Step 5: build and append the event
  const event = {
    uuid: uuidv7(),
    ts: new Date().toISOString(),
    op_code: opCodeOf(final.operator),
    operator: final.operator, // kept denormalized for easy UI access
    target: anchor.hash,
    target_form: anchor.form,
    operand: final.operand || null,
    spo: final.spo || { s:'', p:'', o:'' },
    mode: final.mode,
    domain: final.domain,
    object: final.object,
    site: siteCode(siteFor(final.domain, final.object)),
    site_name: siteFor(final.domain, final.object),
    resolution: resolutionCode(resolutionFor(final.mode, final.object)),
    resolution_name: resolutionFor(final.mode, final.object),
    frame,
    agent,
    clause: c,
    confidence: final.confidence,
    rationale,
    provenance: {
      source: usedModel ? 'model' : 'heuristic',
      path: 'intake',
      tokensIn, tokensOut
    }
  };

  await appendEvent(event);

  // Step 6: materialize CON edges when relevant
  if (final.operator === 'CON' && final.operand) {
    const targetAnchor = makeAnchor(final.operand);
    await upsertAnchor({
      hash: targetAnchor.hash,
      form: targetAnchor.form,
      original: targetAnchor.original,
      type_hint: 'Entity'
    });
    await appendEdge({
      source: anchor.hash,
      target: targetAnchor.hash,
      relation: (final.spo?.p || 'related').toLowerCase(),
      event: event.uuid
    });
  }

  const status = final.confidence < 0.6 ? 'low_confidence' : 'emitted';
  return { status, event, classification: final, usedModel };
}

/**
 * Process a blob of text: split into clauses, classify each.
 * Returns array of { clause, status, event, error }.
 */
export async function ingest(text, options = {}) {
  const clauses = splitIntoClauses(text);
  const results = [];
  for (const c of clauses) {
    try {
      const r = await classifyClause(c, options);
      results.push({ clause: c, ...r });
    } catch(e) {
      results.push({ clause: c, status: 'error', reason: e.message || String(e) });
      // Halt on hard errors (e.g. invalid API key) to avoid wasted calls
      if (e instanceof ModelError && e.code === 'NO_KEY') break;
      if (e instanceof ModelError && e.code?.startsWith('HTTP_4')) break;
    }
  }
  return results;
}

/* ═══ Helpers ══════════════════════════════════════════════════════════ */

function heuristicToResult(clause, heur, operator) {
  const op = OPS[operator];
  return {
    operator,
    mode: op?.mode || heur.mode,
    domain: op?.domain || heur.domain,
    object: heur.object || 'Figure',
    spo: heur.spo || { s:'', p:'', o:'' },
    target: heur.spo?.o || heur.spo?.s || clause.slice(0, 80),
    operand: heur.spo?.o && heur.spo?.s ? heur.spo.o : '',
    confidence: heur.confidence || 0.6
  };
}

function inferTypeHint(operator, object) {
  if (object === 'Ground') return 'Field';
  if (object === 'Pattern') return 'Paradigm';
  return 'Entity';
}

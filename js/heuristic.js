// ══════════════════════════════════════════════════════════════════════
// heuristic.js — the fast, zero-token classification path
//
// This runs first. Model is invoked only when the heuristic returns
// ambiguous or low-confidence. For clean transformation clauses the
// heuristic handles a meaningful fraction of input with no tokens spent.
// ══════════════════════════════════════════════════════════════════════

/**
 * Verb families keyed by operator. Tight lists — precision over recall.
 * When a clause has no clear match, we defer to the model.
 */
const VERB_FAMILIES = {
  INS: {
    verbs: ['created', 'create', 'creates', 'made', 'makes', 'made', 'established', 'establishes', 'establish',
            'founded', 'founds', 'registered', 'registers', 'register', 'enrolled', 'enrolls',
            'added', 'adds', 'introduced', 'introduces', 'launched', 'launches', 'born',
            'filed', 'files', 'opened', 'opens', 'instantiated', 'instantiates', 'minted',
            'generated', 'generates', 'spawned', 'spawns', 'formed', 'forms', 'produced', 'produces',
            'began', 'begins', 'started', 'starts', 'initiated', 'initiates', 'commenced',
            'issued', 'issues', 'published', 'publishes'],
    weight: 1.0
  },
  SEG: {
    verbs: ['split', 'splits', 'divided', 'divides', 'divide', 'separated', 'separates',
            'partitioned', 'partitions', 'filtered', 'filters', 'grouped', 'groups',
            'categorized', 'categorizes', 'segmented', 'segments', 'sorted', 'sorts',
            'bucketed', 'buckets', 'carved', 'carves'],
    // strengthens when followed by "by" or "into groups"
    patterns: [/\b(split|divided|grouped|categorized|sorted|filtered)\s+(?:\w+\s+){0,3}(?:by|into)\b/i],
    weight: 1.0
  },
  CON: {
    verbs: ['linked', 'links', 'link', 'connected', 'connects', 'connect', 'joined', 'joins',
            'paired', 'pairs', 'pair', 'related', 'relates', 'associated', 'associates',
            'matched', 'matches', 'match', 'bound', 'binds', 'tied', 'ties',
            'attached', 'attaches', 'assigned', 'assigns', 'referred',
            'reports', 'reported', 'appointed', 'designated'],
    patterns: [/\b(linked|connected|joined|paired|related|associated)\s+(?:\w+\s+){0,4}(?:to|with)\b/i,
               /\bassigned\s+(?:\w+\s+){0,3}to\b/i],
    weight: 1.0
  },
  SYN: {
    verbs: ['merged', 'merges', 'merge', 'combined', 'combines', 'combine', 'synthesized', 'synthesizes',
            'integrated', 'integrates', 'consolidated', 'consolidates', 'consolidate',
            'unified', 'unifies', 'unify', 'fused', 'fuses', 'amalgamated',
            'produced a consolidated', 'emerged', 'emerges'],
    patterns: [/\b(merged|combined|integrated|consolidated|unified|fused)\s+(?:\w+\s+){0,5}into\s+\w+/i],
    weight: 1.0
  },
  ALT: {
    verbs: ['moved', 'moves', 'changed', 'changes', 'updated', 'updates', 'update',
            'transitioned', 'transitions', 'shifted', 'shifts', 'altered', 'alters',
            'revised', 'revises', 'switched', 'switches', 'adjusted', 'adjusts',
            'modified', 'modifies', 'upgraded', 'downgraded', 'promoted', 'demoted',
            'became', 'becomes',
            'defined', 'defines', 'define', 'set', 'sets', 'specified', 'specifies', 'declared', 'declares',
            'stated', 'states', 'holds', 'asserted', 'asserts'],
    patterns: [/\bfrom\s+\w+(?:\s+\w+)?\s+to\s+\w+/i, // "from X to Y" value transition
               /\b(restated|revalued|adjusted)\b/i,
               /\b(?:is|are|was|were)\s+(?:defined as|declared|set to|equal to)\b/i],
    weight: 1.0
  },
  SUP: {
    verbs: ['weighed', 'weighs', 'reconciled', 'reconciles', 'balanced', 'balances',
            'contrasted', 'contrasts', 'juxtaposed', 'juxtaposes', 'superposed', 'superposes',
            'held', 'holds'],
    // Contradictions held simultaneously ("disagree on", "both X and Y")
    patterns: [/\b(?:disagree|conflict|differ|contradict)\s+(?:on|about)\b/i,
               /\bboth\s+\w+\s+and\s+\w+\b/i,
               /\b(?:tension|trade[- ]off|competing)\s+(?:between|with)\b/i],
    weight: 0.9
  },
  REC: {
    verbs: ['restructured', 'restructures', 'reframed', 'reframes', 'reorganized', 'reorganizes',
            'redefined', 'redefines', 'migrated', 'migrates', 'reclassified', 'reclassifies',
            'reconceived', 'reconceives', 'rebuilt', 'rebuilds'],
    patterns: [/\b(schema|framework|classification|taxonomy|model|system)\s+(?:was|is|has been)\s+(?:changed|restructured|replaced)\b/i,
               /\bchanged\s+(?:what|how)\s+the\s+\w+\s+means\b/i],
    weight: 1.1
  },
  SIG: {
    verbs: ['noticed', 'notices', 'observed', 'observes', 'marked', 'marks',
            'identified', 'identifies', 'flagged', 'flags', 'spotted', 'spots',
            'detected', 'detects', 'recognized', 'recognizes',
            'pointed to', 'pointed out', 'highlighted', 'highlights'],
    weight: 0.85
  },
  NUL: {
    // NUL is rarely emitted as a positive claim; more often absence phrases
    patterns: [/\b(?:remained|stayed|continued)\s+(?:unchanged|the same|as is)\b/i,
               /\bno\s+(?:change|action|modification)\s+was\s+made\b/i,
               /\b(?:passes|passed)\s+through\s+unchanged\b/i,
               /\bnothing\s+(?:changed|happened|was\s+modified)\b/i,
               /\bwithout\s+(?:modification|change|alteration)\b/i],
    weight: 0.95
  }
};

/** Condition hints — language suggesting ambient/background rather than a specific entity. */
const CONDITION_MARKERS = [
  /\b(?:atmosphere|climate|mood|weather|rainfall|drought|temperature|humidity|lighting)\b/i,
  /\b(?:ambient|background|substrate|field|terrain|landscape|environment|surroundings)\b/i,
  /\bacross\s+(?:the\s+)?(?:region|area|territory|basin|whole)\b/i,
  /\b(?:the\s+)?general\s+(?:conditions|state|situation)\b/i
];

/** Pattern hints — language suggesting a recurring regularity. */
const PATTERN_MARKERS = [
  /\b(?:every|all|each)\s+\w+/i,
  /\b(?:pattern|regularity|rule|law|statute|bylaw|regulation|framework|taxonomy|schema|paradigm)\b/i,
  /\b(?:typical|recurring|consistent|systematic)\b/i,
  /\bapplies\s+to\s+(?:every|all|any)\b/i,
  /\b(?:class|category|kind|type)\s+of\b/i
];

/** Entity hints — specific bounded entity (the default, but marked for confidence). */
const ENTITY_MARKERS = [
  /\b(?:Mr|Mrs|Ms|Dr|Prof)\.\s+\w+/,
  /\b[A-Z]\w+\s+[A-Z]\w+/, // Proper Noun Proper Noun — likely a named person/org
  /\b(?:the|this|that|a|an)\s+(?:new\s+)?(?:\w+'s\s+)?\w+\b/
];

/** Fragment/gate signals — NOT transformation claims. */
const GATE_SIGNALS = [
  /^\s*[Hh]ello\s*[.!?]?\s*$/,
  /^\s*[Hh]i\s*[.!?]?\s*$/,
  /^\s*[Tt]est\s*[.!?]?\s*$/,
  /^\s*\w+\s*\?\s*$/, // single-word question
  /^\s*[?!.,;]+\s*$/
];

/* ═══ Core scoring ════════════════════════════════════════════════════ */

function normalizeClause(clause) {
  return String(clause || '').trim();
}

function tokenize(text) {
  return text.toLowerCase().match(/\b[a-z][a-z']*\b/g) || [];
}

function scoreOperator(clause, tokens, op) {
  const family = VERB_FAMILIES[op];
  if (!family) return 0;
  let score = 0;
  if (family.verbs) {
    const verbSet = new Set(family.verbs);
    for (const t of tokens) {
      if (verbSet.has(t)) score += family.weight;
    }
    // check multi-word verb phrases
    for (const v of family.verbs) {
      if (v.includes(' ') && clause.toLowerCase().includes(v)) score += family.weight * 0.8;
    }
  }
  if (family.patterns) {
    for (const pat of family.patterns) {
      if (pat.test(clause)) score += family.weight * 1.2;
    }
  }
  return score;
}

function scoreObject(clause) {
  let condition = 0, entity = 0, pattern = 0;
  for (const r of CONDITION_MARKERS) if (r.test(clause)) condition += 1;
  for (const r of PATTERN_MARKERS) if (r.test(clause)) pattern += 1;
  for (const r of ENTITY_MARKERS) if (r.test(clause)) entity += 0.6;
  // Default weighting: entity unless condition or pattern dominate
  if (condition === 0 && pattern === 0) entity = Math.max(entity, 0.5);
  return { Condition: condition, Entity: entity, Pattern: pattern };
}

/** Heuristic SPO extraction. Returns best-effort S, P, O from a clause. */
export function extractSPO(clause) {
  const c = normalizeClause(clause);
  if (!c) return { s: '', p: '', o: '' };

  // Find main verb — crude but useful: first verb-like token after the first NP.
  // Verb candidates: any token that appears in our verb families.
  const allVerbs = new Set();
  for (const fam of Object.values(VERB_FAMILIES)) {
    if (fam.verbs) for (const v of fam.verbs) allVerbs.add(v.toLowerCase());
  }
  const words = c.match(/\S+/g) || [];
  let verbIdx = -1;
  for (let i = 1; i < words.length; i++) {
    const w = words[i].toLowerCase().replace(/[.,;:!?]$/,'');
    if (allVerbs.has(w)) { verbIdx = i; break; }
    // Also common copulas
    if (/^(is|are|was|were|has|have|had)$/.test(w) && i > 0) {
      // Look for a main verb nearby (passive "was X-ed")
      const next = (words[i+1] || '').toLowerCase().replace(/[.,;:!?]$/,'');
      if (allVerbs.has(next)) { verbIdx = i + 1; break; }
      // Or use the copula itself
      if (verbIdx < 0) verbIdx = i;
    }
  }
  if (verbIdx < 0) {
    // No recognizable verb — return the whole thing as "s", empty p/o
    return { s: c.replace(/[.,;:!?]$/,''), p: '', o: '' };
  }
  const s = words.slice(0, verbIdx).join(' ').replace(/[.,;:!?]$/,'').trim();
  const pRaw = words[verbIdx].replace(/[.,;:!?]$/,'');
  // Absorb particle if adjacent ("linked to", "split by")
  const particle = (words[verbIdx+1] || '').toLowerCase().replace(/[.,;:!?]$/,'');
  const p = ['to','with','by','into','from','on','for','against','about'].includes(particle)
    ? `${pRaw} ${particle}` : pRaw;
  const objStart = p.includes(' ') ? verbIdx + 2 : verbIdx + 1;
  const oRaw = words.slice(objStart).join(' ').replace(/[.,;:!?]$/,'').trim();
  // Trim the object at common clause-break tokens
  const o = oRaw.split(/\s+(?:and then|then|but|however|which|while|after which)\s+/i)[0].trim();
  return { s, p, o };
}

/**
 * Classify a clause using pure heuristics. No model, no network.
 *
 * Returns:
 *   { nul_gate: true }                                       — gate fired
 *   { ambiguous: true, top: [[op, score], ...] }             — model should run
 *   { operator, mode, domain, object, spo, confidence,       — confident
 *     heuristic: true }
 */
export function classifyHeuristic(clause) {
  const c = normalizeClause(clause);
  if (!c) return { nul_gate: true, reason: 'empty' };

  // NUL gate: obvious non-transformations
  for (const g of GATE_SIGNALS) {
    if (g.test(c)) return { nul_gate: true, reason: 'fragment' };
  }
  // Short question without action verbs
  if (/^[^.]*\?\s*$/.test(c) && c.split(/\s+/).length < 6) {
    const tokens = tokenize(c);
    let anyVerb = false;
    for (const fam of Object.values(VERB_FAMILIES)) {
      if (!fam.verbs) continue;
      for (const t of tokens) if (fam.verbs.includes(t)) { anyVerb = true; break; }
      if (anyVerb) break;
    }
    if (!anyVerb) return { nul_gate: true, reason: 'question' };
  }

  // Score each operator
  const tokens = tokenize(c);
  const scores = {};
  for (const op of Object.keys(VERB_FAMILIES)) {
    scores[op] = scoreOperator(c, tokens, op);
  }
  const ranked = Object.entries(scores).sort(([,a],[,b]) => b-a);
  const [bestOp, bestScore] = ranked[0];
  const [, secondScore] = ranked[1];

  // Ambiguous: no signal, or first and second are too close
  if (bestScore < 0.8) {
    return { ambiguous: true, reason: 'low-signal', top: ranked.slice(0, 3) };
  }
  const margin = bestScore - secondScore;
  if (margin < 0.3) {
    return { ambiguous: true, reason: 'close-margin', top: ranked.slice(0, 3) };
  }

  // Score object axis
  const objScores = scoreObject(c);
  const objRanked = Object.entries(objScores).sort(([,a],[,b]) => b-a);
  const [bestObj, bestObjScore] = objRanked[0];
  const object = bestObjScore > 0 ? bestObj : 'Entity';

  const spo = extractSPO(c);

  const confidence = Math.min(0.95, 0.55 + margin * 0.15 + (bestScore - 1) * 0.08);

  // Derive mode and domain from operator
  const OP_MODE = { NUL:'Differentiating', SIG:'Relating', INS:'Generating',
                    SEG:'Differentiating', CON:'Relating', SYN:'Generating',
                    ALT:'Differentiating', SUP:'Relating', REC:'Generating' };
  const OP_DOMAIN = { NUL:'Existence', SIG:'Existence', INS:'Existence',
                      SEG:'Structure', CON:'Structure', SYN:'Structure',
                      ALT:'Significance', SUP:'Significance', REC:'Significance' };

  return {
    operator: bestOp,
    mode: OP_MODE[bestOp],
    domain: OP_DOMAIN[bestOp],
    object,
    spo,
    confidence: +confidence.toFixed(2),
    heuristic: true,
    scores: Object.fromEntries(ranked.slice(0, 3)),
    rationale: `Heuristic match on verb family and context markers. Top op ${bestOp} by margin ${margin.toFixed(2)}.`
  };
}

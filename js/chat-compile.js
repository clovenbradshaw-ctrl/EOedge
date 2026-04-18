// ══════════════════════════════════════════════════════════════════════
// chat-compile.js — prose → nested operator expression
//
// Compiles a user chat message into a canonical EO prefix-form tree.
// Execution is handled elsewhere; this module's job is parsing only.
//
// The tree is JS-object-shaped:
//   { op, operand, context?, ref?, reason? }
// with `operand` recursively another tree, a leaf Ref, or null.
//
// Leaves:
//   { kind: 'anchor', name, hash? }          named entity to resolve
//   { kind: 'time',   from?, to?, label }    parsed time range
//   { kind: 'text',   value }                free-text filter
//   { kind: 'list',   items: [] }            multi-value operand
//   { kind: 'clause', value }                content to classify/ingest
//
// NUL:
//   { op: 'NUL', reason, ref? }              non-transformation request
//
// Canonical string form for receipts:
//   EVA(SEG(anchor:Maria, time:last_week), text:closed)
//   NUL(chitchat)
//   INS(clause:"Maria closed James's referral")
// ══════════════════════════════════════════════════════════════════════

import { classify as embedClassify, isReady as embedReady } from './embeddings.js';

/* ═══ Surface-form patterns ════════════════════════════════════════════ */

const CHITCHAT_PATTERNS = [
  /^\s*(hi|hello|hey|yo|sup|howdy)\s*[.!?]?\s*$/i,
  /^\s*(thanks|thank you|ty|thx|cool|nice|ok|okay|got it|k|kk)\s*[.!?]?\s*$/i,
  /^\s*(good\s+(morning|afternoon|evening|night))\s*[.!?]?\s*$/i,
  /^\s*[\p{Emoji}\s.!?]+\s*$/u
];

// Question-shape markers
const QUESTION_MARKERS = {
  lookup:    /^\s*(what|which|who|where|when|show me|list|find|give me|tell me)\b/i,
  count:     /^\s*(how many|count|number of)\b/i,
  latest:    /\b(latest|most recent|last|newest)\b/i,
  time_span: /\b(today|yesterday|this week|last week|this month|last month|this year|last (day|week|month|year))\b/i,
  time_rel:  /\b(since|before|after|until|between)\b/i,
  relation:  /\b(related to|connected to|linked to|associated with|tied to|linked with)\b/i,
  summary:   /^\s*(summarize|summarise|summary of|overview|what's the pattern|explain|describe what)\b/i,
  decision:  /\b(decide|decided|decision|pick|judgment|resolve|resolved|which is right|which is correct|adjudicate)\b/i,
  define:    /^\s*(define|let\s+\w+\s+(mean|be)|\w+\s+(means|is defined as))\b/i,
  reframe:   /\b(restructure|reframe|change the (framework|taxonomy|schema|model)|redefine (the|our|my))\b/i,
  conflict:  /\b(conflict|conflicts|disagree|disagreement|two values|both say|which one)\b/i
};

// Statements (not questions) — detected by absence of question marker + presence of a verb
const STATEMENT_VERBS = /\b(created|registered|added|closed|opened|assigned|linked|split|merged|changed|moved|defined|declared|logged|filed|updated|moved)\b/i;

// Time-expression parser
const TIME_EXPRESSIONS = [
  { re: /\btoday\b/i,          fn: () => ({ from: startOfDay(0),   to: endOfDay(0),   label: 'today' }) },
  { re: /\byesterday\b/i,      fn: () => ({ from: startOfDay(-1),  to: endOfDay(-1),  label: 'yesterday' }) },
  { re: /\bthis week\b/i,      fn: () => ({ from: startOfWeek(0),  to: now(),         label: 'this week' }) },
  { re: /\blast week\b/i,      fn: () => ({ from: startOfWeek(-1), to: startOfWeek(0),label: 'last week' }) },
  { re: /\bthis month\b/i,     fn: () => ({ from: startOfMonth(0), to: now(),         label: 'this month' }) },
  { re: /\blast month\b/i,     fn: () => ({ from: startOfMonth(-1),to: startOfMonth(0),label: 'last month'}) },
  { re: /\bthis year\b/i,      fn: () => ({ from: startOfYear(0),  to: now(),         label: 'this year' }) },
  { re: /\blast (\d+)\s+(day|week|month|year)s?\b/i,
    fn: (m) => {
      const n = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      const ms = unit==='day'? 86400e3 : unit==='week'? 7*86400e3 : unit==='month'? 30*86400e3 : 365*86400e3;
      return { from: new Date(Date.now() - n*ms).toISOString(), to: now(), label: `last ${n} ${unit}${n>1?'s':''}` };
    }
  }
];
function now() { return new Date().toISOString(); }
function startOfDay(offset) { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+offset); return d.toISOString(); }
function endOfDay(offset)   { const d = new Date(); d.setHours(23,59,59,999); d.setDate(d.getDate()+offset); return d.toISOString(); }
function startOfWeek(offset){ const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - d.getDay() + offset*7); return d.toISOString(); }
function startOfMonth(offset){ const d = new Date(); d.setHours(0,0,0,0); d.setDate(1); d.setMonth(d.getMonth()+offset); return d.toISOString(); }
function startOfYear(offset){ const d = new Date(); d.setHours(0,0,0,0); d.setMonth(0,1); d.setFullYear(d.getFullYear()+offset); return d.toISOString(); }

/* ═══ Slot extractors ══════════════════════════════════════════════════ */

/** Proper noun candidates (crude capitalization heuristic). */
function extractAnchorCandidates(text) {
  const candidates = [];
  // Match sequences of capitalized words, or things following "about|on|for|with"
  const re = /\b([A-Z][\w'\-]*(?:\s+[A-Z][\w'\-]*){0,3})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const token = m[1].trim();
    // Skip sentence-initial single tokens that are question words
    if (/^(What|Who|Which|When|Where|How|Why|Show|List|Find|Tell|Give)$/i.test(token) && m.index === 0) continue;
    candidates.push(token);
  }
  // Also pick up quoted anchors
  const quoted = /"([^"]+)"|'([^']+)'/g;
  while ((m = quoted.exec(text)) !== null) {
    candidates.push((m[1] || m[2]).trim());
  }
  return [...new Set(candidates)];
}

function extractTime(text) {
  for (const { re, fn } of TIME_EXPRESSIONS) {
    const m = re.exec(text);
    if (m) return fn(m);
  }
  return null;
}

function extractTopicText(text) {
  // Anything after "about|on|regarding|concerning" that's not a named anchor
  const m = /\b(?:about|on|regarding|concerning)\s+([\w\s]+?)(?:\s+(?:today|yesterday|this|last|since|before|after|\?|$))/i.exec(text);
  if (m) return m[1].trim();
  return null;
}

/* ═══ Compile ═════════════════════════════════════════════════════════ */

/**
 * Compile a chat message into an operator tree.
 * Returns { tree, prose, rationale, used_embeddings }.
 */
export async function compile(text, { useEmbeddings = false } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { tree: nul('empty'), prose: '', rationale: 'empty input' };

  // 1. Gate: chitchat → NUL
  for (const p of CHITCHAT_PATTERNS) {
    if (p.test(raw)) return { tree: nul('chitchat', raw), prose: raw, rationale: 'matched chitchat gate' };
  }

  // 2. Detect speech act by surface markers
  const sig = detectSpeechAct(raw);

  // 3. Extract slots
  const anchors = extractAnchorCandidates(raw);
  const time = extractTime(raw);
  const topic = extractTopicText(raw);

  // 4. Build the tree based on the detected act
  let tree;
  if (sig === 'chitchat') {
    tree = nul('chitchat', raw);
  } else if (sig === 'statement') {
    tree = { op: 'INS', operand: { kind: 'clause', value: raw } };
  } else if (sig === 'define') {
    const m = /^(?:define|let)\s+([\w\s]+?)\s+(?:mean|be|as)\s+(.+)$/i.exec(raw)
           || /^([\w\s]+?)\s+means\s+(.+)$/i.exec(raw)
           || /^([\w\s]+?)\s+is defined as\s+(.+)$/i.exec(raw);
    if (m) {
      tree = { op: 'DEF', operand: { kind: 'anchor', name: m[1].trim() }, context: { kind: 'text', value: m[2].trim() } };
    } else {
      tree = nul('parse_fail', 'define without clear subject/definition');
    }
  } else if (sig === 'reframe') {
    tree = { op: 'REC', operand: { kind: 'clause', value: raw } };
  } else if (sig === 'summary') {
    tree = synOrEva(raw, anchors, time, topic, 'SYN');
  } else if (sig === 'decision' || sig === 'conflict') {
    tree = synOrEva(raw, anchors, time, topic, 'EVA');
  } else if (sig === 'relation') {
    tree = conTree(raw, anchors, time, topic);
  } else if (sig === 'query') {
    tree = segTree(raw, anchors, time, topic);
  } else {
    // Ambiguous — if embeddings ready, use them to disambiguate
    if (useEmbeddings && embedReady()) {
      try {
        const cls = await embedClassify(raw);
        tree = treeFromClassification(cls, raw, anchors, time, topic);
      } catch(e) {
        tree = nul('unclassified', raw);
      }
    } else {
      tree = nul('unclassified', raw);
    }
  }

  return {
    tree,
    prose: raw,
    rationale: `speech_act=${sig}; anchors=${anchors.length}; time=${time ? time.label : 'none'}; topic=${topic || 'none'}`,
    used_embeddings: false
  };
}

/* ═══ Speech-act detection ═════════════════════════════════════════════ */

function detectSpeechAct(text) {
  // Order matters: define/reframe/summary > conflict > relation > query > statement > fallback
  if (QUESTION_MARKERS.define.test(text)) return 'define';
  if (QUESTION_MARKERS.reframe.test(text)) return 'reframe';
  if (QUESTION_MARKERS.summary.test(text)) return 'summary';
  if (QUESTION_MARKERS.decision.test(text) || QUESTION_MARKERS.conflict.test(text)) return 'decision';
  if (QUESTION_MARKERS.relation.test(text)) return 'relation';
  if (QUESTION_MARKERS.lookup.test(text) || QUESTION_MARKERS.count.test(text) || /\?\s*$/.test(text)) return 'query';
  if (STATEMENT_VERBS.test(text) && !/\?\s*$/.test(text)) return 'statement';
  return 'ambiguous';
}

/* ═══ Tree constructors ═══════════════════════════════════════════════ */

function nul(reason, ref) {
  return { op: 'NUL', operand: null, reason, ref };
}

function segTree(raw, anchors, time, topic) {
  // Build a SEG over anchors, time, and topic — inner-to-outer narrowing
  let inner = null;
  if (anchors.length === 1) {
    inner = { kind: 'anchor', name: anchors[0] };
  } else if (anchors.length > 1) {
    inner = { kind: 'list', items: anchors.map(name => ({ kind: 'anchor', name })) };
  }
  if (!inner && !time && !topic) {
    // General query with no narrowing — scope to "recent"
    return { op: 'SEG', operand: null, context: { kind: 'time', label: 'recent', from: null, to: null, limit: 50 } };
  }
  // Layer: SEG(SEG(anchor, time), topic)
  let tree = inner ? { op: 'SEG', operand: inner, context: null } : null;
  if (time) {
    tree = { op: 'SEG', operand: tree || null, context: { kind: 'time', ...time } };
  }
  if (topic) {
    tree = { op: 'SEG', operand: tree || null, context: { kind: 'text', value: topic } };
  }
  return tree || nul('parse_fail', raw);
}

function conTree(raw, anchors, time, topic) {
  if (!anchors.length) return nul('parse_fail', 'CON requires at least one anchor');
  const primary = { kind: 'anchor', name: anchors[0] };
  const others = anchors.slice(1);
  const inner = others.length
    ? { kind: 'list', items: others.map(name => ({ kind: 'anchor', name })) }
    : (topic ? { kind: 'text', value: topic } : null);
  return { op: 'CON', operand: primary, context: inner };
}

function synOrEva(raw, anchors, time, topic, op) {
  // Use SEG as inner narrowing, then apply SYN or EVA as outer judgment
  const inner = segTree(raw, anchors, time, topic);
  if (inner.op === 'NUL') return inner;
  return {
    op,
    operand: inner,
    context: { kind: 'text', value: op === 'EVA' ? 'superpose' : 'summary' }
  };
}

function treeFromClassification(cls, raw, anchors, time, topic) {
  const op = cls.operator;
  switch (op) {
    case 'NUL': return nul('embed:classified_null', raw);
    case 'SIG': return nul('embed:attention', raw); // ephemeral — don't log, don't act
    case 'INS': return { op: 'INS', operand: { kind: 'clause', value: raw } };
    case 'SEG': return segTree(raw, anchors, time, topic);
    case 'CON': return conTree(raw, anchors, time, topic);
    case 'SYN': return synOrEva(raw, anchors, time, topic, 'SYN');
    case 'DEF': return { op: 'DEF', operand: { kind: 'clause', value: raw } };
    case 'EVA': return synOrEva(raw, anchors, time, topic, 'EVA');
    case 'REC': return { op: 'REC', operand: { kind: 'clause', value: raw } };
    default: return nul('embed:unknown', raw);
  }
}

/* ═══ Tree → canonical string (for receipts) ═══════════════════════════ */

export function toNotation(tree) {
  if (!tree) return '';
  if (tree.op === 'NUL') return `NUL(${tree.reason}${tree.ref ? ':'+truncate(tree.ref, 24) : ''})`;
  const operand = renderLeaf(tree.operand);
  const context = tree.context ? renderLeaf(tree.context) : null;
  return context ? `${tree.op}(${operand}, ${context})` : `${tree.op}(${operand})`;
}

function renderLeaf(leaf) {
  if (!leaf) return '∅';
  if (leaf.op) return toNotation(leaf); // nested tree
  if (leaf.kind === 'anchor') return `anchor:${leaf.name}`;
  if (leaf.kind === 'time') return `time:${leaf.label || 'range'}`;
  if (leaf.kind === 'text') return `text:"${truncate(leaf.value || '', 20)}"`;
  if (leaf.kind === 'clause') return `clause:"${truncate(leaf.value || '', 24)}"`;
  if (leaf.kind === 'list') return `[${leaf.items.map(renderLeaf).join(', ')}]`;
  return '?';
}

function truncate(s, n) {
  const str = String(s);
  return str.length > n ? str.slice(0, n-1) + '…' : str;
}

/* ═══ Tree → pretty multiline (for inspector expand view) ══════════════ */

export function toPretty(tree, depth = 0) {
  const pad = '  '.repeat(depth);
  if (!tree) return pad + '∅';
  if (tree.op === 'NUL') return pad + `NUL  (${tree.reason})`;
  let out = pad + tree.op + '(';
  if (tree.operand?.op) {
    out += '\n' + toPretty(tree.operand, depth + 1);
    if (tree.context) out += ',\n' + pad + '  context: ' + renderLeaf(tree.context);
    out += '\n' + pad + ')';
  } else {
    out += renderLeaf(tree.operand);
    if (tree.context) out += ', ' + renderLeaf(tree.context);
    out += ')';
  }
  return out;
}

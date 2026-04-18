// ══════════════════════════════════════════════════════════════════════
// model.js — the three-question model interface
//
// Per spec §7, the tiny model is asked three bounded questions:
//   1. Argument extraction    — operator + target + operand from a clause
//   2. Resolution-face stance — the Mode × Object grain
//   3. EVA adjudication       — pick among superposed values
//
// This module defines the interface. The current adapter calls the
// Anthropic API with structured JSON output. To swap in ONNX Runtime Web
// running a quantized Phi-3 or Gemma 2B, replace `callModel()` with
// the local inference function and keep the three exported methods stable.
// ══════════════════════════════════════════════════════════════════════

const LS_API_KEY = 'eo-local-api-key';
const LS_MODEL_URL = 'eo-local-model-url';

export function setApiKey(key) {
  try { localStorage.setItem(LS_API_KEY, key || ''); } catch(e) {}
}
export function getApiKey() {
  try { return localStorage.getItem(LS_API_KEY) || ''; } catch(e) { return ''; }
}
export function hasApiKey() {
  return !!getApiKey();
}

/**
 * Call the model with a prompt expecting JSON-only output.
 * Returns { json, tokensIn, tokensOut } or throws.
 *
 * This is the swap point: replace with ONNX inference, llama.cpp WASM,
 * or any local runtime when available.
 */
async function callModel(prompt, maxTokens = 400) {
  const key = getApiKey();
  if (!key) throw new ModelError('NO_KEY', 'No model key set');
  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  };
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new ModelError(`HTTP_${resp.status}`, text.slice(0, 200));
  }
  const data = await resp.json();
  const block = (data.content || []).find(b => b.type === 'text');
  if (!block) throw new ModelError('EMPTY', 'No text in model response');
  let raw = block.text.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  let json;
  try { json = JSON.parse(raw); }
  catch(e) { throw new ModelError('PARSE', `Could not parse JSON: ${raw.slice(0, 100)}`); }
  const usage = data.usage || {};
  return {
    json,
    tokensIn: usage.input_tokens || Math.ceil(prompt.length / 4),
    tokensOut: usage.output_tokens || Math.ceil(raw.length / 4)
  };
}

export class ModelError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ─── 7.1 Argument extraction ──────────────────────────────────────────

const EXTRACT_PROMPT = (clause, context) => `You are an EO (Experiential Ontology) classifier. For a single clause, extract the transformation structure and answer the three classification questions. Return JSON only.

The nine operators (Mode × Domain):
NUL  (Differentiating × Existence)    · non-transformation, pass-through
SIG  (Relating × Existence)           · drawing a distinction, attention
INS  (Generating × Existence)         · instantiating a concrete thing
SEG  (Differentiating × Structure)    · partitioning, boundary-drawing
CON  (Relating × Structure)           · establishing a relationship
SYN  (Generating × Structure)         · synthesizing an emergent whole
DEF  (Differentiating × Significance) · changing value within the frame
EVA  (Relating × Significance)        · holding contradictions simultaneously
REC  (Generating × Significance)      · changing the frame itself

Q1 · Mode: Differentiating | Relating | Generating
Q2 · Domain: Existence | Structure | Significance
Q3 · Object: Condition | Entity | Pattern
   (Condition = ambient/background; Entity = specific bounded thing; Pattern = recurring regularity)

${context ? `Context (for reference only, do not classify):\n"${context.replace(/"/g,'\\"')}"\n\n` : ''}Clause: "${clause.replace(/"/g,'\\"')}"

Return JSON only, no code fence, no prose:
{"operator":"NUL|SIG|INS|SEG|CON|SYN|DEF|EVA|REC","target":"concise noun phrase","operand":"what it becomes or acts with, or empty","spo":{"s":"subject","p":"predicate","o":"object-or-empty"},"mode":"...","domain":"...","object":"Condition|Entity|Pattern","confidence":0.85,"rationale":"one short sentence","nul_gate":false}

If the input is not a transformation claim, set nul_gate=true and leave other fields as empty strings or zeros.`;

/**
 * Extract operator, target, operand, and three-question axes from a clause.
 *
 * @param {string} clause
 * @param {string} [context]
 * @returns {Promise<{operator, target, operand, spo, mode, domain, object, confidence, rationale, nul_gate, tokensIn, tokensOut}>}
 */
export async function extractArgs(clause, context = '') {
  const { json, tokensIn, tokensOut } = await callModel(EXTRACT_PROMPT(clause, context), 450);
  return {
    operator: json.operator || '',
    target: json.target || '',
    operand: json.operand || '',
    spo: json.spo || { s:'', p:'', o:'' },
    mode: json.mode || '',
    domain: json.domain || '',
    object: json.object || '',
    confidence: typeof json.confidence === 'number' ? json.confidence : 0,
    rationale: json.rationale || '',
    nul_gate: !!json.nul_gate,
    tokensIn, tokensOut
  };
}

// ─── 7.2 Resolution-face classification ────────────────────────────────

const RESOLUTION_PROMPT = (clause, operator) => `You are an EO Resolution-face classifier.

The Resolution face (Mode × Object) names the stance of engagement:
  Clearing     (Differentiating × Condition) · dissolving conditions, opening space
  Dissecting   (Differentiating × Entity)    · separating a specific entity into parts
  Unraveling   (Differentiating × Pattern)   · loosening a recurring pattern
  Tending      (Relating × Condition)        · shaping ambient conditions
  Binding      (Relating × Entity)           · holding a specific entity in relation
  Tracing      (Relating × Pattern)          · following a recurring pattern
  Cultivating  (Generating × Condition)      · generating ambient conditions
  Making       (Generating × Entity)         · producing a specific entity
  Composing    (Generating × Pattern)        · generating a recurring pattern

Operator: ${operator}
Clause: "${clause.replace(/"/g,'\\"')}"

Return JSON only:
{"resolution":"Clearing|Dissecting|Unraveling|Tending|Binding|Tracing|Cultivating|Making|Composing","confidence":0.85}`;

export async function classifyResolution(clause, operator) {
  const { json, tokensIn, tokensOut } = await callModel(RESOLUTION_PROMPT(clause, operator), 100);
  return {
    resolution: json.resolution || '',
    confidence: typeof json.confidence === 'number' ? json.confidence : 0,
    tokensIn, tokensOut
  };
}

// ─── 7.3 EVA adjudication ──────────────────────────────────────────────

const ADJUDICATE_PROMPT = (target, values, context) => `You are an EO EVA adjudicator. Several DEF values exist for the same target. Choose which one should be projected. The others remain in the log — this is not a delete; it is a projection choice rendered against the current frame.

Target: ${target}

Candidates:
${values.map((v, i) => `  [${i}] ${JSON.stringify(v.value)} · source: ${v.source} · ts: ${v.timestamp}${v.provenance?.confidence != null ? ' · conf: '+v.provenance.confidence : ''}`).join('\n')}

${context ? `Neighboring context:\n${context}\n\n` : ''}Return JSON only:
{"winner_index":0,"reason":"short explanation (≤ 20 tokens)","confidence":0.85}`;

export async function adjudicateEVA(target, values, context = '') {
  const { json, tokensIn, tokensOut } = await callModel(ADJUDICATE_PROMPT(target, values, context), 120);
  return {
    winnerIndex: typeof json.winner_index === 'number' ? json.winner_index : 0,
    reason: json.reason || '',
    confidence: typeof json.confidence === 'number' ? json.confidence : 0,
    tokensIn, tokensOut
  };
}

// ─── Prose synthesis (narrow, bounded) ─────────────────────────────────

/**
 * Free-prose call for SYN operator paths. Input is an already-classified
 * event set plus a directive; output is short natural-language prose.
 * Unlike extractArgs/classifyResolution/adjudicateEVA this doesn't return
 * structured JSON — the model is answering in bounded prose because the
 * caller (chat-execute SYN) needs prose.
 *
 * Kept narrow: at most ~40 events passed in, max 300 tokens out, model
 * instructed to avoid speculation.
 */
export async function summarize({ events, directive, maxTokens = 300 }) {
  if (!hasApiKey()) throw new ModelError('NO_KEY', 'No model key set');
  const packed = (events || []).slice(0, 40).map((e, i) => {
    const ts = (e.ts || '').slice(0, 16).replace('T', ' ');
    return `[${i}] ${ts} ${e.operator}(${e.resolution_name || '?'}, ${e.site_name || '?'}) ${e.target_form || ''}${e.operand ? ' → '+e.operand : ''}: "${String(e.clause||'').slice(0, 120)}"`;
  }).join('\n');
  const prompt = `You are summarizing classified EO events. Return 2-3 short paragraphs in prose. Focus on structural observations: what recurs, what changed, where the signal is. Do not invent facts not present in the events below. Do not use markdown. Prose only.

Directive: ${directive || 'Summarize the pattern.'}

Events:
${packed}`;

  const key = getApiKey();
  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  };
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new ModelError(`HTTP_${resp.status}`, text.slice(0, 200));
  }
  const data = await resp.json();
  const block = (data.content || []).find(b => b.type === 'text');
  if (!block) throw new ModelError('EMPTY', 'No text in response');
  const usage = data.usage || {};
  return {
    text: block.text.trim(),
    tokensIn: usage.input_tokens || Math.ceil(prompt.length / 4),
    tokensOut: usage.output_tokens || Math.ceil((block.text || '').length / 4)
  };
}

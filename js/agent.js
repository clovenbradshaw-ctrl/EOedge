// ══════════════════════════════════════════════════════════════════════
// agent.js — chat orchestrator
//
// Every turn:
//   1. Send user message + history to the local model with the tool list.
//   2. If the model calls a tool, run it deterministically, append the
//      result, and call the model again to narrate.
//   3. Return { chat, mechanism } where mechanism is null (no data
//      referenced) or a cover-note + records pair.
//   4. Post-check: any number, ISO date, or proper-noun-shaped token in
//      the chat slot must trace to the tool result. Flag if not.
// ══════════════════════════════════════════════════════════════════════

import { complete, supportsNativeTools } from './local-model.js';
import { TOOL_DEFS, runTool } from './agent-tools.js';

const SYSTEM_PROMPT = `You are EO Local, an on-device assistant. The user has a personal log of classified "events" (facts, observations, statements they have recorded). You can call tools to query that log.

RULES:
- For conversational turns (greetings, thanks, clarifications, opinions, general questions), just answer in plain prose. Do not call a tool.
- For any question that asks about the user's log — what they recorded, what an entity does, when something happened, how many of something — call a tool. Bias toward calling a tool if the question mentions an entity, a time, a count, or anything that could plausibly be in the log.
- After a tool returns, narrate the result in one or two short sentences. Do not invent records, dates, or counts that the tool did not return. If the tool returned nothing, say so plainly.
- Keep replies short. No markdown, no headers, no bullet lists unless the user asks. Plain prose.
- Refer to dates and times the way a person would speak ("yesterday", "April 13"), not as ISO strings.
- Never repeat the tool's cover note verbatim — the user already sees it. Add the human take.

ANTI-FABRICATION (critical):
- NEVER invent a statement, quote, or fact and attribute it to the user. Do not write things like "User has logged…", "You said…", or "The user mentioned…" unless that text came back from a tool result you just called.
- NEVER put quoted content in your reply unless the exact quoted string was returned by a tool.
- NEVER describe tool calls or tool results to the user. Do not write "I called find_events", "the tool returned", "the count_events tool returned a count of…", or anything similar. Just answer in plain prose using the facts the tool gave you.
- Do not mention tool names (find_events, count_events, recent_events, list_entities) in your reply. Ever.
- If you have no tool result and the user's message is conversational, just answer conversationally. Do not describe a log, do not summarize the log, do not give examples of what might be in the log.
- If you cannot answer without data and have no tool result, say "I don't have anything on that in the log yet" — do not guess.`;

function promptToolInstructions() {
  const lines = TOOL_DEFS.map(t => {
    const f = t.function;
    const props = f.parameters?.properties || {};
    const params = Object.entries(props)
      .map(([k, v]) => `    - ${k} (${v.type || 'string'}): ${v.description || ''}`.trimEnd())
      .join('\n');
    return `- ${f.name}: ${f.description}${params ? '\n' + params : ''}`;
  }).join('\n');
  return `
AVAILABLE TOOLS:
${lines}

TOOL-CALL PROTOCOL:
- To call a tool, respond with ONE line of raw JSON and nothing else, shaped exactly like this example:
  {"name": "find_events", "arguments": {"time": "yesterday"}}
- No code fences, no <tool_call> tags, no prose before or after — the JSON object must be the entire response.
- To answer without a tool, respond in plain prose only (no JSON anywhere).
- After a tool result arrives, narrate it in one or two short sentences of prose. Do not emit another JSON call in the same turn.`;
}

function parsePromptToolCall(content) {
  if (!content) return null;
  let text = String(content).trim();

  // Strip Qwen's native <tool_call>…</tool_call> wrapper if the model falls
  // back to its trained function-calling format.
  const tagged = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (tagged) text = tagged[1].trim();

  // Strip a single fenced code block.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) text = fenced[1].trim();

  let parsed = null;
  try { parsed = JSON.parse(text); } catch(e) {}

  if (!parsed) {
    // Scan for the first balanced object that names a tool under any of the
    // common keys (tool / name / tool_name / function).
    const start = text.search(/\{[\s\S]*?"(?:tool|name|tool_name|function)"\s*:/);
    if (start >= 0) {
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try { parsed = JSON.parse(text.slice(start, i + 1)); } catch(e) {}
            break;
          }
        }
      }
    }
  }

  if (!parsed) return null;
  const toolName = parsed.tool || parsed.name || parsed.tool_name || parsed.function;
  if (typeof toolName !== 'string') return null;

  const rawArgs = parsed.args ?? parsed.arguments ?? parsed.parameters ?? {};
  let argsStr;
  if (typeof rawArgs === 'string') argsStr = rawArgs;
  else {
    try { argsStr = JSON.stringify(rawArgs); } catch(e) { argsStr = '{}'; }
  }

  return {
    id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    function: { name: toolName, arguments: argsStr }
  };
}

const MAX_TURNS = 4;

/* Chitchat short-circuit. Small local models (1–3B) like to treat a "Hello"
   as a cue to fabricate example log content. Catch the obvious conversational
   turns up front and respond without invoking the model at all. */
const CHITCHAT_PATTERNS = [
  /^\s*(hi|hello|hey|yo|sup|howdy)[\s.!?,]*$/i,
  /^\s*(good\s+(morning|afternoon|evening|night))[\s.!?,]*$/i,
  /^\s*(thanks|thank you|ty|thx|cheers)[\s.!?,]*$/i,
  /^\s*(cool|nice|ok|okay|got it|k|kk|sure|great)[\s.!?,]*$/i,
  /^\s*[\p{Emoji}\s.!?]+\s*$/u
];

function chitchatReply(text) {
  const t = text.trim().toLowerCase();
  if (/^(hi|hello|hey|yo|sup|howdy|good\s+(morning|afternoon|evening|night))/i.test(t)) {
    return "Hi. Ask a question about your log, state a fact, or drop a document.";
  }
  if (/^(thanks|thank you|ty|thx|cheers)/i.test(t)) return "Sure.";
  return "Got it.";
}

/**
 * Run one user turn through the local model.
 * @param {string} userText
 * @param {Array<{role, content}>} history  prior chat messages
 * @returns {Promise<{chat:string, mechanism:object|null, warnings:string[], usage:object}>}
 */
export async function runTurn(userText, history = []) {
  for (const p of CHITCHAT_PATTERNS) {
    if (p.test(userText)) {
      return {
        chat: chitchatReply(userText),
        mechanism: null,
        warnings: [],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        tool_calls_run: 0
      };
    }
  }

  const useNative = supportsNativeTools();
  const systemContent = useNative
    ? SYSTEM_PROMPT
    : SYSTEM_PROMPT + '\n' + promptToolInstructions();

  const messages = [
    { role: 'system', content: systemContent },
    ...history.slice(-8),
    { role: 'user', content: userText }
  ];

  let mechanism = null;
  const usageTotal = { prompt_tokens: 0, completion_tokens: 0 };
  let toolCallsRun = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = await complete({
      messages,
      tools: useNative ? TOOL_DEFS : null,
      tool_choice: useNative ? 'auto' : undefined,
      temperature: 0.3,
      max_tokens: 384
    });
    accumulateUsage(usageTotal, reply.usage);

    let toolCalls = reply.tool_calls && reply.tool_calls.length ? reply.tool_calls : null;
    if (!toolCalls && !useNative) {
      const parsed = parsePromptToolCall(reply.content);
      if (parsed) toolCalls = [parsed];
    }

    if (toolCalls && toolCalls.length) {
      if (useNative) {
        messages.push({
          role: 'assistant',
          content: reply.content || '',
          tool_calls: toolCalls
        });
      } else {
        messages.push({ role: 'assistant', content: reply.content || '' });
      }
      for (const call of toolCalls) {
        const name = call.function?.name;
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); }
        catch(e) { args = {}; }
        const result = await runTool(name, args);
        toolCallsRun++;
        if (!mechanism) {
          mechanism = result.mechanism;
        } else {
          mechanism = mergeMechanism(mechanism, result.mechanism);
        }
        const toolBody = result.for_model || JSON.stringify(result.mechanism || {});
        if (useNative) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id || `${name}-${turn}`,
            content: toolBody
          });
        } else {
          messages.push({
            role: 'user',
            content: `TOOL_RESULT (${name}):\n${toolBody}\n\nNow write one or two short sentences of plain prose for the user based on this result. Do NOT emit another JSON tool call.`
          });
        }
      }
      continue;
    }

    // No tool call — this is the chat answer
    const chat = (reply.content || '').trim();
    const warnings = postCheck(chat, mechanism);
    // If the post-check caught a fabricated quote or attribution with no
    // backing tool result, suppress the hallucinated text entirely rather
    // than display it to the user.
    const fabricated = !mechanism && warnings.some(w =>
      w === 'fabricated_attribution' ||
      w === 'fabricated_tool_call' ||
      w.startsWith('unsourced_quote:')
    );
    const safeChat = fabricated
      ? "I don't have anything on that in the log yet. Ask me something specific, state a fact to log, or drop a document."
      : (chat || (mechanism ? defaultNarration(mechanism) : '...'));
    return {
      chat: safeChat,
      mechanism,
      warnings,
      usage: usageTotal,
      tool_calls_run: toolCallsRun
    };
  }

  // Hit the turn limit — return whatever we have
  return {
    chat: mechanism ? defaultNarration(mechanism) : 'I went around in circles on that one. Try rephrasing?',
    mechanism,
    warnings: ['agent_loop_exhausted'],
    usage: usageTotal,
    tool_calls_run: toolCallsRun
  };
}

function accumulateUsage(total, u) {
  if (!u) return;
  total.prompt_tokens += u.prompt_tokens || 0;
  total.completion_tokens += u.completion_tokens || 0;
}

function mergeMechanism(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    lookup: `${a.lookup} Then: ${b.lookup}`,
    result_count: (a.result_count || 0) + (b.result_count || 0),
    records: [...(a.records || []), ...(b.records || [])]
  };
}

function defaultNarration(m) {
  if (!m) return '';
  if (m.result_count === 0) return 'Nothing in the log matches that.';
  if (m.result_count === 1) return 'One record matches — see below.';
  return `${m.result_count} records match — see below.`;
}

/* ═══ Post-check ════════════════════════════════════════════════════════
   Cheap, conservative: pull integers and dates from the chat, check that
   each appears either in the tool results or in the user's recent messages.
   Returns warning codes; the UI decides what to do with them.
   ════════════════════════════════════════════════════════════════════ */

function postCheck(chat, mechanism) {
  const warnings = [];
  if (!chat) return warnings;

  // Fabrication check: quoted strings and third-person attributions to the
  // user must trace to a tool result. Without one, these are hallucinations.
  const quotes = extractQuotes(chat);
  const sourcedQuotes = new Set();
  if (mechanism) {
    for (const r of mechanism.records || []) {
      if (r.clause) sourcedQuotes.add(normalizeQuote(r.clause));
      if (r.label)  sourcedQuotes.add(normalizeQuote(r.label));
    }
  }
  for (const q of quotes) {
    if (!q) continue;
    if (!sourcedQuotes.has(normalizeQuote(q))) warnings.push(`unsourced_quote:${q.slice(0, 80)}`);
  }

  // Third-person attribution phrases ("user has logged", "you said", etc.)
  // are only legitimate when we actually pulled records to back them.
  const FABRICATION_PHRASES = [
    /\buser\s+(?:has\s+)?(?:logged|said|stated|recorded|reported|mentioned|noted)\b/i,
    /\byou\s+(?:said|stated|logged|recorded|mentioned|reported|noted)\b/i,
    /\bthe\s+user\s+(?:said|stated|logged|recorded|mentioned|reported|noted)\b/i,
    /\baccording\s+to\s+(?:the\s+)?(?:user|log)\b/i
  ];
  const hasRecords = mechanism && (mechanism.records || []).length > 0;
  if (!hasRecords) {
    for (const p of FABRICATION_PHRASES) {
      if (p.test(chat)) { warnings.push('fabricated_attribution'); break; }
    }
  }

  // Tool-talk fabrication. Small models love to narrate imaginary tool
  // pipelines ("the find_events tool returned a list of UFO sightings").
  // If the model mentions a tool by name or uses "tool returned"/"tool called"
  // phrasing AT ALL, we treat it as leaking mechanism into the chat slot —
  // and if no real tool ran, we treat the content as fabricated outright.
  const TOOL_TALK = [
    /\b(?:find_events|count_events|recent_events|list_entities)\b/i,
    /\bthe\s+tool\s+(?:returned|called|said|reported)\b/i,
    /\b(?:I|we|you)\s+called\s+(?:the\s+)?\w*_events?\b/i,
    /\breturned\s+a\s+(?:count|list|total)\s+of\b/i
  ];
  for (const p of TOOL_TALK) {
    if (p.test(chat)) {
      warnings.push(hasRecords ? 'tool_talk_in_reply' : 'fabricated_tool_call');
      break;
    }
  }

  const numbersInChat = extractNumbers(chat);
  const datesInChat = extractDates(chat);

  if (numbersInChat.length === 0 && datesInChat.length === 0) return warnings;

  const sourcedNumbers = new Set();
  const sourcedDates = new Set();

  if (mechanism) {
    sourcedNumbers.add(String(mechanism.result_count));
    for (const r of mechanism.records || []) {
      for (const n of extractNumbers(`${r.label} ${r.clause} ${r.when} ${r.where}`)) sourcedNumbers.add(n);
      for (const d of extractDates(`${r.when} ${r.label}`)) sourcedDates.add(d.toLowerCase());
    }
  }

  for (const n of numbersInChat) {
    if (n === '0' || n === '1') continue;            // trivial
    if (!sourcedNumbers.has(n)) warnings.push(`unsourced_number:${n}`);
  }
  for (const d of datesInChat) {
    if (!sourcedDates.has(d.toLowerCase())) warnings.push(`unsourced_date:${d}`);
  }
  return warnings;
}

function extractQuotes(s) {
  const out = [];
  // Straight and curly double quotes; require at least two words inside to
  // avoid flagging scare-quotes on single terms.
  const re = /["“]([^"”]{6,})["”]/g;
  let m;
  while ((m = re.exec(s))) {
    const inner = m[1].trim();
    if (/\s/.test(inner)) out.push(inner);
  }
  return out;
}

function normalizeQuote(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractNumbers(s) {
  const out = [];
  const re = /\b(\d{1,6})\b/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}

function extractDates(s) {
  const out = [];
  // Month-name dates: "April 13", "April 13, 2026"
  const monthRe = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?\b/gi;
  let m;
  while ((m = monthRe.exec(s))) out.push(m[0]);
  // ISO-ish
  const isoRe = /\b\d{4}-\d{2}-\d{2}\b/g;
  while ((m = isoRe.exec(s))) out.push(m[0]);
  return out;
}

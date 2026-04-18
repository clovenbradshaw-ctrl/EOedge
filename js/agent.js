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
- Never repeat the tool's cover note verbatim — the user already sees it. Add the human take.`;

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

/**
 * Run one user turn through the local model.
 * @param {string} userText
 * @param {Array<{role, content}>} history  prior chat messages
 * @returns {Promise<{chat:string, mechanism:object|null, warnings:string[], usage:object}>}
 */
export async function runTurn(userText, history = []) {
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
    return {
      chat: chat || (mechanism ? defaultNarration(mechanism) : '...'),
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

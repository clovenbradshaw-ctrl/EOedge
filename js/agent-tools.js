// ══════════════════════════════════════════════════════════════════════
// agent-tools.js — the surface the local model can call
//
// Each tool wraps a deterministic store operation and returns:
//   - records: the structured rows the chat narration must trace to
//   - mechanism: a human-readable cover note + record list, ready to render
//
// Mechanism is what the user sees in the inspect panel. Tools NEVER emit
// jargon ("op_code=4", "filter.target=…") — they emit prose a colleague
// would write on a Post-it.
// ══════════════════════════════════════════════════════════════════════

import { getEvents, countEvents, getRecentEvents, getAllAnchors } from './store.js';
import { OPS, OP_ORDER } from './ops.js';

const OPERATOR_NAMES = OP_ORDER;

/* ═══ Tool schemas (OpenAI function-calling shape) ═════════════════════ */

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'find_events',
      description: 'Search the user\'s logged events. Use whenever the user asks about what happened, what was recorded, what entity X is involved in, or anything that could be answered from the log. Returns matching records.',
      parameters: {
        type: 'object',
        properties: {
          entity:    { type: 'string', description: 'Name of an entity, person, or thing to filter by. Optional.' },
          text:      { type: 'string', description: 'Free-text search across event content. Optional.' },
          time:      { type: 'string', description: 'Time range. One of: today, yesterday, last_week, this_week, last_month, this_month, all. Default all.' },
          operator:  { type: 'string', description: 'Filter by operator name. One of NUL, SIG, INS, SEG, CON, SYN, ALT, SUP, REC. Optional.' },
          limit:     { type: 'integer', description: 'Maximum records to return. Default 25, max 200.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'count_events',
      description: 'Count matching events without returning the rows. Use when the user asks "how many", "how often", or wants a number.',
      parameters: {
        type: 'object',
        properties: {
          entity:   { type: 'string' },
          text:     { type: 'string' },
          time:     { type: 'string', description: 'today, yesterday, last_week, this_week, last_month, this_month, all' },
          operator: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recent_events',
      description: 'Get the most recently logged events. Use when the user asks "what\'s new", "what just happened", or wants context on the latest activity.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'How many recent events. Default 10, max 50.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_entities',
      description: 'List the entities (anchors) the user has named in the log. Use when the user asks "what do you know about", "what entities exist", or names something you need to verify exists.',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Substring to match against entity names. Optional.' }
        }
      }
    }
  }
];

/* ═══ Time resolution ══════════════════════════════════════════════════ */

function resolveTime(label) {
  const now = new Date();
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
  const endOfDay   = (d) => { const x = new Date(d); x.setHours(23,59,59,999); return x; };
  const iso = (d) => d.toISOString();

  switch ((label || 'all').toLowerCase()) {
    case 'today':       return { from: iso(startOfDay(now)), to: iso(endOfDay(now)),       human: 'today' };
    case 'yesterday':   { const y = new Date(now); y.setDate(y.getDate()-1); return { from: iso(startOfDay(y)), to: iso(endOfDay(y)), human: 'yesterday' }; }
    case 'this_week':   { const s = startOfDay(now); s.setDate(s.getDate() - s.getDay()); return { from: iso(s), to: iso(endOfDay(now)), human: 'this week' }; }
    case 'last_week':   { const e = startOfDay(now); e.setDate(e.getDate() - e.getDay() - 1); const s = new Date(e); s.setDate(s.getDate() - 6); return { from: iso(startOfDay(s)), to: iso(endOfDay(e)), human: 'last week' }; }
    case 'this_month':  { const s = new Date(now.getFullYear(), now.getMonth(), 1); return { from: iso(s), to: iso(endOfDay(now)), human: 'this month' }; }
    case 'last_month':  { const s = new Date(now.getFullYear(), now.getMonth()-1, 1); const e = new Date(now.getFullYear(), now.getMonth(), 0); return { from: iso(startOfDay(s)), to: iso(endOfDay(e)), human: 'last month' }; }
    case 'all':
    case '':
    default:            return { human: 'all time' };
  }
}

/* ═══ Filter assembly ══════════════════════════════════════════════════ */

async function entityToTargetForms(entityQuery) {
  if (!entityQuery) return null;
  const anchors = await getAllAnchors();
  const q = entityQuery.toLowerCase();
  return anchors.filter(a =>
    (a.form || '').toLowerCase().includes(q) ||
    (a.original || '').toLowerCase().includes(q)
  );
}

function opCode(name) {
  if (!name) return null;
  const upper = String(name).toUpperCase();
  return OPS[upper]?.code ?? null;
}

/* ═══ Human-readable formatting ════════════════════════════════════════ */

function humanDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate()-1);
  const sameYest = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `today at ${time}`;
  if (sameYest) return `yesterday at ${time}`;
  const date = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  return `${date} at ${time}`;
}

function eventLabel(e) {
  const op = OPS[e.operator];
  const opName = op ? op.name : (e.operator || 'event');
  const subject = e.spo?.s || e.target_form || '?';
  const predicate = e.spo?.p || (e.operator ? `(${opName.toLowerCase()})` : '');
  const obj = e.spo?.o || e.operand || '';
  const stem = obj ? `${subject} ${predicate} ${obj}`.trim() : `${subject} ${predicate}`.trim();
  return stem;
}

function recordRow(e) {
  return {
    id: e.uuid,
    label: eventLabel(e),
    when: humanDate(e.ts),
    where: e.site_name || '',
    operator: e.operator,
    operator_name: OPS[e.operator]?.name || e.operator,
    clause: e.clause || '',
    confidence: e.confidence
  };
}

function describeFilters({ entity, text, time, operator, anchorMatches }) {
  const parts = [];
  if (operator) parts.push(`${OPS[operator.toUpperCase()]?.name?.toLowerCase() || operator} events`);
  else parts.push('events');
  if (entity) {
    if (anchorMatches && anchorMatches.length === 0) parts.push(`mentioning "${entity}" (no known entity matches)`);
    else if (anchorMatches && anchorMatches.length === 1) parts.push(`involving ${anchorMatches[0].original || anchorMatches[0].form}`);
    else if (anchorMatches && anchorMatches.length > 1) parts.push(`involving any of ${anchorMatches.length} entities matching "${entity}"`);
    else parts.push(`mentioning "${entity}"`);
  }
  if (text) parts.push(`containing "${text}"`);
  if (time && time.human && time.human !== 'all time') parts.push(time.human === 'today' || time.human === 'yesterday' || time.human === 'last week' || time.human === 'this week' || time.human === 'last month' || time.human === 'this month' ? time.human : `in ${time.human}`);
  return parts.join(', ');
}

/* ═══ Tools ════════════════════════════════════════════════════════════ */

export async function find_events(args = {}) {
  const limit = Math.min(Math.max(1, args.limit || 25), 200);
  const time = resolveTime(args.time);
  const op = opCode(args.operator);
  const anchorMatches = args.entity ? await entityToTargetForms(args.entity) : null;

  // Run one query per matched anchor (or no anchor filter).
  let events = [];
  const baseFilter = { limit };
  if (time.from) baseFilter.from = time.from;
  if (time.to) baseFilter.to = time.to;
  if (op != null) baseFilter.op_code = op;
  if (args.text) baseFilter.text = args.text;

  if (anchorMatches && anchorMatches.length > 0) {
    for (const a of anchorMatches) {
      const rows = await getEvents({ ...baseFilter, target: a.hash });
      events.push(...rows);
      if (events.length >= limit) break;
    }
    events = events.slice(0, limit);
  } else if (anchorMatches && anchorMatches.length === 0) {
    events = [];
  } else {
    events = await getEvents(baseFilter);
  }

  const filterDesc = describeFilters({
    entity: args.entity, text: args.text, time, operator: args.operator, anchorMatches
  });
  const verb = events.length === 0 ? 'Found nothing' :
               events.length === 1 ? 'Found 1' :
               `Found ${events.length}`;
  const lookup = `Looked for ${filterDesc}. ${verb}.`;
  const records = events.map(recordRow);
  return {
    ok: true,
    records,
    mechanism: {
      lookup,
      result_count: events.length,
      records
    },
    // Compact form for the model to read in the next turn
    for_model: events.length === 0
      ? `(no records)`
      : events.slice(0, limit).map((e, i) => `[${i+1}] ${e.uuid} · ${humanDate(e.ts)} · ${eventLabel(e)} · "${(e.clause||'').slice(0,140)}"`).join('\n')
  };
}

export async function count_events(args = {}) {
  const time = resolveTime(args.time);
  const op = opCode(args.operator);
  const anchorMatches = args.entity ? await entityToTargetForms(args.entity) : null;

  let n = 0;
  const baseFilter = {};
  if (time.from) baseFilter.from = time.from;
  if (time.to) baseFilter.to = time.to;
  if (op != null) baseFilter.op_code = op;
  if (args.text) baseFilter.text = args.text;

  if (anchorMatches && anchorMatches.length > 0) {
    for (const a of anchorMatches) {
      n += await countEvents({ ...baseFilter, target: a.hash });
    }
  } else if (anchorMatches && anchorMatches.length === 0) {
    n = 0;
  } else {
    n = await countEvents(baseFilter);
  }

  const filterDesc = describeFilters({
    entity: args.entity, text: args.text, time, operator: args.operator, anchorMatches
  });
  const lookup = `Counted ${filterDesc}. Found ${n}.`;
  return {
    ok: true,
    count: n,
    mechanism: { lookup, result_count: n, records: [] },
    for_model: `count = ${n}`
  };
}

export async function recent_events(args = {}) {
  const limit = Math.min(Math.max(1, args.limit || 10), 50);
  const events = await getRecentEvents(limit);
  const records = events.map(recordRow);
  const lookup = events.length === 0
    ? `Looked for the most recent events. Found nothing.`
    : `Looked at the ${events.length} most recent event${events.length===1?'':'s'}.`;
  return {
    ok: true,
    records,
    mechanism: { lookup, result_count: events.length, records },
    for_model: events.length === 0
      ? `(no records)`
      : events.map((e, i) => `[${i+1}] ${e.uuid} · ${humanDate(e.ts)} · ${eventLabel(e)} · "${(e.clause||'').slice(0,140)}"`).join('\n')
  };
}

export async function list_entities(args = {}) {
  const all = await getAllAnchors();
  const q = (args.filter || '').toLowerCase();
  const matches = q
    ? all.filter(a => (a.form||'').toLowerCase().includes(q) || (a.original||'').toLowerCase().includes(q))
    : all;
  const sorted = matches.slice(0, 100);
  const lookup = q
    ? (sorted.length === 0 ? `Looked up entities matching "${args.filter}". Found nothing.`
                           : `Looked up entities matching "${args.filter}". Found ${matches.length}${matches.length>100?` — showing 100`:''}.`)
    : (sorted.length === 0 ? `Looked at all known entities. Found nothing.`
                           : `Looked at all known entities. Found ${matches.length}${matches.length>100?` — showing 100`:''}.`);
  const records = sorted.map(a => ({
    id: a.hash,
    label: a.original || a.form,
    when: '',
    where: a.type_hint || 'Entity',
    operator: '',
    clause: ''
  }));
  return {
    ok: true,
    entities: sorted,
    mechanism: { lookup, result_count: matches.length, records },
    for_model: sorted.length === 0
      ? `(no entities)`
      : sorted.map((a, i) => `[${i+1}] ${a.original || a.form} (${a.type_hint || 'entity'})`).join('\n')
  };
}

/* ═══ Dispatch ══════════════════════════════════════════════════════════ */

export const TOOLS = {
  find_events,
  count_events,
  recent_events,
  list_entities
};

export async function runTool(name, args) {
  const fn = TOOLS[name];
  if (!fn) {
    return {
      ok: false,
      error: `Unknown tool: ${name}`,
      mechanism: { lookup: `Tried to use a tool I don't have ("${name}"). Did nothing.`, result_count: 0, records: [] },
      for_model: `error: unknown tool ${name}`
    };
  }
  try {
    return await fn(args || {});
  } catch(e) {
    return {
      ok: false,
      error: e.message || String(e),
      mechanism: { lookup: `Tried "${name}" but it failed: ${e.message || e}.`, result_count: 0, records: [] },
      for_model: `error: ${e.message || e}`
    };
  }
}

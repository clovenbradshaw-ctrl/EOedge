// ══════════════════════════════════════════════════════════════════════
// chat-render.js — ExecResult → natural-language response + receipt
//
// Turns the execution output into what the chat surface actually displays:
// a main reply (text), a receipt (counts, tokens, operator tree), and
// optional inline controls (e.g. conflict adjudication buttons).
// ══════════════════════════════════════════════════════════════════════

import { toNotation } from './chat-compile.js';

export function render(tree, result) {
  const op = result?.op || tree?.op;

  if (result?.nul) return renderNUL(tree, result);
  switch (op) {
    case 'INS': return renderINS(tree, result);
    case 'SEG': return renderSEG(tree, result);
    case 'CON': return renderCON(tree, result);
    case 'SYN': return renderSYN(tree, result);
    case 'ALT': return renderALT(tree, result);
    case 'SUP': return renderSUP(tree, result);
    case 'REC': return renderREC(tree, result);
    default:    return { text: "I couldn't route this request. Try rephrasing.", receipt: receiptFor(tree, result) };
  }
}

/* ═══ Per-operator renderers ═══════════════════════════════════════════ */

function renderNUL(tree, result) {
  const reason = result.nul.reason;
  let text;
  if (reason === 'chitchat') text = pickOne(['Got it.', 'Mm.', 'Noted.', 'OK.', '👍']);
  else if (reason === 'empty_tree' || reason === 'empty') text = '—';
  else if (reason === 'unclassified') text = "I'm not sure what you're asking. Could you rephrase?";
  else if (reason === 'parse_fail') text = `I couldn't parse that into a request. ${result.nul.ref ? '("' + result.nul.ref + '")' : ''}`.trim();
  else if (reason === 'empty_result') text = "Nothing matches that in the log. It's either never been recorded, or it's outside the scope you named.";
  else if (reason === 'nothing_to_synthesize') text = "Nothing to summarize — the scope you named produced no events.";
  else if (reason === 'no_conflicts_in_scope') text = "No open ALT superpositions in that scope. All values are settled.";
  else if (reason === 'no_connections') text = `No connections recorded from ${result.nul.anchor || 'that anchor'}.`;
  else if (reason === 'con_requires_anchor') text = "I need a named entity to look up connections.";
  else if (reason === 'alt_requires_term') text = "I need to know what term you want to assert a value for.";
  else if (reason === 'depth_exceeded') text = 'That expression nested too deep for me to evaluate safely.';
  else text = `Non-transformation: ${reason}.`;
  return { text, receipt: receiptFor(tree, result), nul: true };
}

function renderINS(tree, result) {
  const events = result.events || [];
  if (events.length === 0) {
    return { text: "Nothing to log — the content was gated or didn't classify.", receipt: receiptFor(tree, result) };
  }
  const byOp = {};
  for (const e of events) byOp[e.operator] = (byOp[e.operator] || 0) + 1;
  const breakdown = Object.entries(byOp).map(([op, n]) => `${n}×${op}`).join(' · ');
  let text;
  if (events.length === 1) {
    const e = events[0];
    text = `Logged · ${e.operator}(${e.resolution_name || '?'}, ${e.site_name || '?'}) on ${e.target_form}.`;
  } else {
    text = `Logged ${events.length} event${events.length===1?'':'s'} · ${breakdown}.`;
  }
  return { text, receipt: receiptFor(tree, result), events };
}

function renderSEG(tree, result) {
  const events = result.events || [];
  const filter = result.filter || {};
  if (!events.length) {
    return { text: "Nothing in scope.", receipt: receiptFor(tree, result) };
  }
  const label = describeFilter(filter);
  const preview = events.slice(0, 5);
  const lines = preview.map(e => {
    const ts = e.ts?.slice(0, 16).replace('T', ' ') || '';
    return `· ${ts} · ${e.operator} · ${e.spo?.s || ''} ▸ ${e.spo?.p || ''} ▸ ${e.spo?.o || e.operand || ''}`;
  });
  let text = `${events.length} event${events.length===1?'':'s'} ${label}.`;
  if (preview.length) text += '\n' + lines.join('\n');
  if (events.length > preview.length) text += `\n(+${events.length - preview.length} more — open in the inspector)`;
  return { text, receipt: receiptFor(tree, result), events };
}

function renderCON(tree, result) {
  const edges = result.edges || [];
  if (!edges.length) {
    return { text: `No connections recorded from ${result.anchor?.name || 'that entity'}.`, receipt: receiptFor(tree, result) };
  }
  const lines = edges.slice(0, 8).map(e => `· ${e.relation} → ${e.to_form}`);
  let text = `${edges.length} connection${edges.length===1?'':'s'} from ${result.anchor?.name}:\n${lines.join('\n')}`;
  if (edges.length > 8) text += `\n(+${edges.length - 8} more)`;
  return { text, receipt: receiptFor(tree, result), edges };
}

function renderSYN(tree, result) {
  const text = result.synthesis || 'Nothing to synthesize.';
  return { text, receipt: receiptFor(tree, result), events: result.events };
}

function renderALT(tree, result) {
  const ev = result.events?.[0];
  if (!ev) return { text: 'Assertion not recorded.', receipt: receiptFor(tree, result) };
  return {
    text: `Asserted · ${ev.target_form} = "${ev.operand}"`,
    receipt: receiptFor(tree, result),
    events: result.events
  };
}

function renderSUP(tree, result) {
  const adj = result.adjudications || [];
  if (!adj.length) return { text: 'Nothing to adjudicate.', receipt: receiptFor(tree, result) };
  const lines = adj.slice(0, 5).map(a => {
    const vals = a.candidates.map(c => JSON.stringify(c.value)).join(' vs ');
    if (a.resolution) return `· ${a.target}: resolved by rule — ${JSON.stringify(a.candidates[a.resolution.winnerIndex].value)}`;
    return `· ${a.target}: ${vals} — needs your call`;
  });
  let text = `${adj.length} conflict${adj.length===1?'':'s'} in scope:\n${lines.join('\n')}`;
  return { text, receipt: receiptFor(tree, result), adjudications: adj };
}

function renderREC(tree, result) {
  return { text: result.notes || 'Frame-change proposal surfaced.', receipt: receiptFor(tree, result) };
}

/* ═══ Helpers ═════════════════════════════════════════════════════════ */

function receiptFor(tree, result) {
  return {
    notation: toNotation(tree),
    events_scanned: result?.cost?.events_scanned || 0,
    tokens: result?.cost?.tokens || 0,
    model_calls: result?.cost?.model_calls || 0,
    events_returned: result?.events?.length || 0,
    notes: result?.notes || ''
  };
}

function describeFilter(f) {
  const parts = [];
  if (f._target_name) parts.push(`on ${f._target_name}`);
  if (f._time_label) parts.push(f._time_label);
  if (f.text) parts.push(`matching "${f.text}"`);
  return parts.length ? parts.join(' ') : 'in the current projection';
}

function pickOne(list) {
  return list[Math.floor(Math.random() * list.length)];
}

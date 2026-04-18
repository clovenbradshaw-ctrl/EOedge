// ══════════════════════════════════════════════════════════════════════
// run-mode.js — mode toggle (llm-only vs eo-pipeline)
//
//   'eo'       (default) — the full stack: nine-operator pipeline for
//                          uploads, compile/execute for chat, all the
//                          EO log-primary machinery.
//   'llm-only'           — skip the stack. Uploads extract text and
//                          attach it as context. Chat turns are routed
//                          straight to the local model with no operator
//                          trees or log projections.
// ══════════════════════════════════════════════════════════════════════

const LS_KEY = 'eo-run-mode';
const MODES = ['eo', 'llm-only'];
const _listeners = new Set();

export function getMode() {
  try {
    const v = localStorage.getItem(LS_KEY);
    return MODES.includes(v) ? v : 'eo';
  } catch(e) { return 'eo'; }
}

export function setMode(m) {
  if (!MODES.includes(m)) return;
  try { localStorage.setItem(LS_KEY, m); } catch(e) {}
  for (const fn of _listeners) {
    try { fn(m); } catch(e) {}
  }
}

export function onModeChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function isEO()      { return getMode() === 'eo'; }
export function isLLMOnly() { return getMode() === 'llm-only'; }

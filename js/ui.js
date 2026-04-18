// ══════════════════════════════════════════════════════════════════════
// ui.js — all UI rendering and event wiring
//
// Six surfaces per spec §10:
//   1. Input         — textarea, drop zone (mic planned for v2)
//   2. Lattice strip — three 3×3 grids (Act, Site, Resolution)
//   3. Stream        — scrollable list of events, current projection
//   4. Conflicts     — ALT superpositions needing adjudication
//   5. REC proposals — surfaced pattern detections from fold
//   6. Compute footer — live counters, GPU=0, Network=0 enforced
// ══════════════════════════════════════════════════════════════════════

import { OPS, OP_ORDER, SITE_ORDER, RESOLUTION_ORDER, OBJECT_ORDER, DOMAIN_ORDER, MODE_ORDER,
         DESERT_CELL, siteFor, resolutionFor, phasepostNotation } from './ops.js';
import { project, findConflicts, summary, actFaceCounts, siteFaceCounts, resolutionFaceCounts } from './horizon.js';
import { ingest } from './intake.js';
import { getMetrics, storageEstimate, clearAll, resetMetrics, appendEvent, updateMetrics } from './store.js';
import { loadSeeds } from './seeds.js';
import { setApiKey, getApiKey, hasApiKey, adjudicateSUP as modelAdjudicate } from './model.js';
import { tryRules, installRule, availableStrategies } from './rules.js';
import { uuidv7, shortHash, makeAnchor } from './anchor.js';

/* ═══ UI STATE ════════════════════════════════════════════════════════ */
const state = {
  filter: { operator: null, object: null, site: null, resolution: null, text: '' },
  expandedEventId: null,
  proposals: [],         // incoming from fold
  dismissedProposalIds: new Set(),
  classifying: false,
  showSettings: false
};

/* ═══ INITIAL RENDER ══════════════════════════════════════════════════ */
export function initUI({ onClassify, onAdjudicate, onAcceptProposal, onRejectProposal, onRefresh }) {
  renderHeader();
  renderIntake({ onClassify });
  renderLattice();
  renderStream();
  renderConflicts({ onAdjudicate });
  renderProposals({ onAcceptProposal, onRejectProposal });
  renderFooter();
  renderToastContainer();
  // Expose refresh for external callers
  ui.refresh = onRefresh;
}

/* ═══ HEADER ══════════════════════════════════════════════════════════ */
function renderHeader() {
  const el = document.getElementById('site-header');
  el.innerHTML = `
    <div class="header-inner">
      <div class="brand">
        <div class="caption">Experiential Ontology · Local Runtime</div>
        <h1 class="brand-name">EO<span class="slash">//</span>Local</h1>
        <p class="brand-sub">On-device AI runtime. Classify once on the fold. Query many on CPU.</p>
      </div>
      <div id="eff-badge" class="eff-badge">
        <div class="caption">No calls yet</div>
        <div class="caption mute">classify or seed</div>
      </div>
    </div>`;
}

export async function updateEffBadge() {
  const m = await getMetrics();
  const el = document.getElementById('eff-badge');
  if (!el) return;
  const total = m.modelTokensIn + m.modelTokensOut;
  if (m.modelCalls === 0 && m.heuristicCalls === 0) {
    el.innerHTML = `<div class="caption">No calls yet</div><div class="caption mute">classify or seed</div>`;
    return;
  }
  const avg = m.modelCalls > 0 ? total / m.modelCalls : 300;
  const savedTokens = (m.horizonQueries + m.heuristicCalls) * avg;
  const ratio = total > 0 ? (savedTokens / total).toFixed(1) : '∞';
  el.innerHTML = `
    <div class="caption" style="font-size:9px;">Session efficiency</div>
    <div class="eff-row"><span class="ratio">${ratio}×</span></div>
    <div class="caption mute">${m.horizonQueries + m.heuristicCalls} CPU / ${m.modelCalls} model</div>`;
}

/* ═══ INTAKE ══════════════════════════════════════════════════════════ */
function renderIntake({ onClassify }) {
  const el = document.getElementById('intake-section');
  el.innerHTML = `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">Intake</h2>
        <div class="caption panel-sub">Heuristic first · model on fallback · NUL-gate non-transformations</div>
      </div>
      <button class="btn-link" onclick="window.__ui.toggleSettings()">settings</button>
    </div>
    <div class="panel-body">
      <div id="settings-block" class="settings-block hidden">
        <p>Optional model key (stored locally; used only as fallback when heuristics are ambiguous).</p>
        <div class="settings-row">
          <input type="password" class="api-key" id="api-key-input" placeholder="sk-ant-..." value="${getApiKey()}">
          <button class="btn btn-ghost" onclick="window.__ui.saveKey()">Save</button>
        </div>
        <p class="caption" style="margin-top:8px;opacity:0.7;">Without a key, the runtime uses heuristics only — anything ambiguous is skipped. Use the seed button to populate the log and exercise the downstream panels.</p>
      </div>
      <textarea class="clause-input" id="intake-input" placeholder="Paste a sentence, paragraph, or drop a transformation description here. Multiple clauses are split client-side."></textarea>
      <div class="intake-row">
        <div class="btn-group">
          <button class="btn btn-primary" id="classify-btn" onclick="window.__ui.classify()">Classify →</button>
          <button class="btn btn-ghost" id="seed-btn" onclick="window.__ui.seed()">Load seeds</button>
        </div>
        <div>
          <button class="btn btn-danger" onclick="window.__ui.clearLog()">Clear log</button>
        </div>
      </div>
      <div id="intake-status"></div>
      <div id="last-result"></div>
    </div>`;
}

async function handleClassify(onClassify) {
  const input = document.getElementById('intake-input');
  const text = input.value.trim();
  if (!text || state.classifying) return;
  state.classifying = true;
  setClassifyBtn(true);
  setIntakeStatus(`Classifying…`, 'info');

  try {
    const results = await ingest(text, { frame: 'default', agent: 'user' });
    const emitted = results.filter(r => r.status === 'emitted' || r.status === 'low_confidence');
    const gated = results.filter(r => r.status === 'nul_gated');
    const failed = results.filter(r => r.status === 'error' || r.status === 'model_failed');

    if (failed.length) {
      const f = failed[0];
      setIntakeStatus(`Failed on "${f.clause.slice(0,50)}…": ${f.reason || 'unknown'}`, 'error');
    } else {
      setIntakeStatus('', null);
      input.value = '';
    }
    if (emitted.length) renderLastResult(emitted[0]);
    else if (gated.length) renderLastResult({ status: 'nul_gated', count: gated.length });

    await ui.refresh?.();
  } catch(e) {
    setIntakeStatus(`Error: ${e.message || e}`, 'error');
  } finally {
    state.classifying = false;
    setClassifyBtn(false);
  }
}

function setClassifyBtn(busy) {
  const b = document.getElementById('classify-btn');
  if (!b) return;
  if (busy) { b.innerHTML = '<span class="pulse">Classifying…</span>'; b.disabled = true; }
  else { b.innerHTML = 'Classify →'; b.disabled = false; }
}

function setIntakeStatus(msg, kind) {
  const el = document.getElementById('intake-status');
  if (!el) return;
  if (!msg) { el.innerHTML = ''; return; }
  const cls = kind === 'error' ? 'alert-error' : 'alert-info';
  el.innerHTML = `<div class="alert ${cls}">${escape(msg)}</div>`;
}

function renderLastResult(result) {
  const el = document.getElementById('last-result');
  if (!el) return;
  if (result.status === 'nul_gated') {
    el.innerHTML = `
      <div class="last-result nul-gate">
        <div class="lr-head"><span class="glyph slate">∅</span><span class="caption">NUL gate · ${result.count || 1} clause${(result.count||1)===1?'':'s'}</span></div>
        <div class="lr-body">Input classified as non-transformation. Nothing emitted.</div>
      </div>`;
    return;
  }
  const ev = result.event;
  if (!ev) { el.innerHTML = ''; return; }
  const op = OPS[ev.operator];
  const flag = result.status === 'low_confidence' ? ' · flagged for review' : '';
  el.innerHTML = `
    <div class="last-result" style="border-left-color:${op.color};">
      <div class="lr-head">
        <span class="glyph" style="background:${op.tint};color:${op.color};">${op.glyph}</span>
        <div>
          <div class="lr-opname" style="color:${op.color};">${ev.operator} · ${op.name}</div>
          <div class="caption mute">${op.triad} triad · ${op.role} role${flag}</div>
        </div>
      </div>
      ${renderSPO(ev.spo)}
      <div class="lr-notation">${renderNotation(ev)}</div>
      <div class="caption" style="margin-top:4px;">
        confidence ${((ev.confidence||0)*100).toFixed(0)}% ·
        <span style="color:var(--ink-faint);">${ev.provenance?.source === 'heuristic' ? 'heuristic · 0 tokens' : `model · ${ev.provenance?.tokensIn || 0}+${ev.provenance?.tokensOut || 0} tokens`}</span>
        ${ev.rationale ? ` · <em class="rationale-inline">${escape(ev.rationale)}</em>` : ''}
      </div>
    </div>`;
}

/* ═══ LATTICE ═════════════════════════════════════════════════════════ */
function renderLattice() {
  const el = document.getElementById('lattice-section');
  el.innerHTML = `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">Faces</h2>
        <div class="caption panel-sub">Three 3×3 projections of the 27-cell capacity ground · tap to scope</div>
      </div>
    </div>
    <div class="panel-body">
      <div class="lattice-triple" id="lattice-triple"></div>
    </div>`;
}

export async function updateLattice() {
  const el = document.getElementById('lattice-triple');
  if (!el) return;

  const allEvents = (await project({ _silent: true, limit: 1e9 })).events;

  // Act face: 9 operators in 3×3 (Mode × Domain)
  const actMap = {};
  for (const op of OP_ORDER) actMap[op] = 0;
  // Site face: 9 terrains in 3×3 (Domain × Object)
  const siteMap = {};
  for (const s of SITE_ORDER) siteMap[s] = 0;
  // Resolution face: 9 stances in 3×3 (Mode × Object)
  const resMap = {};
  for (const r of RESOLUTION_ORDER) resMap[r] = 0;

  for (const ev of allEvents) {
    actMap[ev.operator] = (actMap[ev.operator] || 0) + 1;
    const site = ev.site_name || siteFor(ev.domain, ev.object);
    if (site in siteMap) siteMap[site] += 1;
    const r = ev.resolution_name || resolutionFor(ev.mode, ev.object);
    if (r in resMap) resMap[r] += 1;
  }

  el.innerHTML = `
    <div class="lattice-face">
      <div class="face-title">Act face <span class="caption mute">· Mode × Domain</span></div>
      ${renderFaceGrid('act', MODE_ORDER, DOMAIN_ORDER, (m, d) => {
        const op = OP_ORDER.find(k => OPS[k].mode === m && OPS[k].domain === d);
        const count = actMap[op] || 0;
        const opData = OPS[op];
        const isSelected = state.filter.operator === op;
        return {
          label: op, sublabel: opData.name,
          count, color: opData.color, tint: opData.tint,
          glyph: opData.glyph, selected: isSelected,
          onclick: `window.__ui.setOperatorFilter('${op}')`
        };
      })}
    </div>
    <div class="lattice-face">
      <div class="face-title">Site face <span class="caption mute">· Domain × Object</span></div>
      ${renderFaceGrid('site', DOMAIN_ORDER, OBJECT_ORDER, (d, o) => {
        const site = siteFor(d, o);
        const count = siteMap[site] || 0;
        const isSelected = state.filter.site === site;
        const isDesert = false; // no desert at site level
        return {
          label: site, sublabel: '',
          count, color: 'var(--teal)', tint: 'var(--teal-pale)',
          glyph: '', selected: isSelected,
          onclick: `window.__ui.setSiteFilter('${site}')`
        };
      })}
    </div>
    <div class="lattice-face">
      <div class="face-title">Resolution face <span class="caption mute">· Mode × Object</span></div>
      ${renderFaceGrid('res', MODE_ORDER, OBJECT_ORDER, (m, o) => {
        const res = resolutionFor(m, o);
        const count = resMap[res] || 0;
        const isSelected = state.filter.resolution === res;
        // Desert (SYN × Condition) lives at the 27-cell combo; resolution face is fine on its own.
        return {
          label: res, sublabel: '',
          count, color: 'var(--violet)', tint: 'var(--violet-pale)',
          glyph: '', selected: isSelected,
          onclick: `window.__ui.setResolutionFilter('${res}')`
        };
      })}
    </div>`;
}

function renderFaceGrid(kind, rows, cols, cellFn) {
  let html = `<div class="face-grid"><div class="fg-corner"></div>`;
  for (const c of cols) html += `<div class="fg-col-head">${c}</div>`;
  for (const r of rows) {
    html += `<div class="fg-row-head">${r}</div>`;
    for (const c of cols) {
      const cell = cellFn(r, c);
      const filled = cell.count > 0;
      const bg = filled ? `background:${cell.tint};` : '';
      html += `<button class="fg-cell ${cell.selected ? 'selected' : ''} ${filled ? 'filled' : ''}" style="${bg}" onclick="${cell.onclick}" title="${cell.label}${cell.sublabel ? ' · '+cell.sublabel : ''} — ${cell.count} event${cell.count===1?'':'s'}">
        <span class="fg-glyph" style="color:${cell.color};">${cell.glyph || ''}</span>
        <span class="fg-label">${cell.label}</span>
        <span class="fg-count">${cell.count || ''}</span>
      </button>`;
    }
  }
  html += `</div>`;
  return html;
}

/* ═══ STREAM ══════════════════════════════════════════════════════════ */
function renderStream() {
  const el = document.getElementById('stream-section');
  el.innerHTML = `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">Stream</h2>
        <div class="caption panel-sub" id="stream-sub">Given-Log · append-only</div>
      </div>
      <div id="stream-filters"></div>
    </div>
    <div class="panel-body">
      <input type="text" class="text-field" id="stream-search" placeholder="search clause, subject, predicate, object…">
      <div id="stream-list"></div>
    </div>`;
  document.getElementById('stream-search').addEventListener('input', (e) => {
    state.filter.text = e.target.value;
    updateStream();
  });
}

export async function updateStream() {
  const sub = document.getElementById('stream-sub');
  const list = document.getElementById('stream-list');
  const filters = document.getElementById('stream-filters');
  if (!list) return;

  const filterForProject = {
    operator: state.filter.operator,
    object: state.filter.object,
    site: state.filter.site,
    resolution: state.filter.resolution,
    text: state.filter.text,
    limit: 200
  };
  const { events, count } = await project(filterForProject);
  const allCount = (await summary()).total;
  sub.textContent = `Given-Log · ${count} of ${allCount} events`;

  // Active filter chips
  const active = [];
  if (state.filter.operator) active.push({ k:'operator', label: `${OPS[state.filter.operator].glyph} ${state.filter.operator}` });
  if (state.filter.object)   active.push({ k:'object',   label: `obj: ${state.filter.object}` });
  if (state.filter.site)     active.push({ k:'site',     label: `site: ${state.filter.site}` });
  if (state.filter.resolution) active.push({ k:'resolution', label: `res: ${state.filter.resolution}` });
  filters.innerHTML = active.length
    ? `<div class="filter-chips">${active.map(a => `<span class="chip" onclick="window.__ui.clearFilter('${a.k}')"><span>${escape(a.label)}</span><span class="chip-x">×</span></span>`).join('')}<button class="chip-clear" onclick="window.__ui.clearAllFilters()">clear</button></div>`
    : '';

  if (!events.length) {
    list.innerHTML = `<div class="empty">${allCount === 0 ? 'The log is empty — classify a clause above, or load the seed examples.' : 'No events match the current projection.'}</div>`;
    return;
  }
  list.innerHTML = `<ul class="event-list">${events.slice(0, 80).map(renderEvent).join('')}</ul>
    ${events.length > 80 ? `<div class="caption center mute">+ ${events.length - 80} more in scope</div>` : ''}`;
}

function renderEvent(ev) {
  const op = OPS[ev.operator];
  if (!op) return '';
  const expanded = state.expandedEventId === ev.uuid;
  const ts = new Date(ev.ts);
  const tsL = isNaN(ts) ? '' : ts.toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  return `<li class="event-row">
    <button class="event-head" onclick="window.__ui.toggleEvent('${ev.uuid}')">
      <span class="glyph" style="background:${op.tint};color:${op.color};">${op.glyph}</span>
      <div class="event-main">
        <div class="event-notation">${renderNotation(ev)}</div>
        ${renderSPO(ev.spo, true)}
        <div class="event-clause">"${escape(ev.clause)}"</div>
      </div>
      <span class="event-time">${tsL}</span>
    </button>
    ${expanded ? renderEventDetails(ev, op) : ''}
  </li>`;
}

function renderEventDetails(ev, op) {
  const site = ev.site_name || siteFor(ev.domain, ev.object);
  const res = ev.resolution_name || resolutionFor(ev.mode, ev.object);
  return `<div class="event-details" style="border-left-color:${op.color}88;">
    <div class="face-box">
      <div class="lab">Act face</div>
      <div class="v1">${escape(ev.mode)}</div>
      <div class="v2">× ${escape(ev.domain)}</div>
    </div>
    <div class="face-box">
      <div class="lab">Site face</div>
      <div class="v1">${escape(site)}</div>
      <div class="v2">${escape(ev.domain)} × ${escape(ev.object)}</div>
    </div>
    <div class="face-box">
      <div class="lab">Resolution face</div>
      <div class="v1">${escape(res)}</div>
      <div class="v2">${escape(ev.mode)} × ${escape(ev.object)}</div>
    </div>
    <div class="face-box">
      <div class="lab">Anchor</div>
      <div class="v1 mono">${shortHash(ev.target)}</div>
      <div class="v2">conf ${((ev.confidence||0)*100).toFixed(0)}%</div>
    </div>
    <div class="face-box">
      <div class="lab">Provenance</div>
      <div class="v1">${escape(ev.provenance?.source || 'unknown')}</div>
      <div class="v2">${ev.provenance?.tokensIn ? `${ev.provenance.tokensIn}+${ev.provenance.tokensOut}t` : '0 tokens'}</div>
    </div>
    <div class="face-box">
      <div class="lab">Agent</div>
      <div class="v1">${escape(ev.agent)}</div>
      <div class="v2 mono">${escape(ev.uuid.slice(0,8))}</div>
    </div>
    ${ev.rationale ? `<div class="rationale">"${escape(ev.rationale)}"</div>` : ''}
  </div>`;
}

/* ═══ CONFLICTS ═══════════════════════════════════════════════════════ */
function renderConflicts({ onAdjudicate }) {
  const el = document.getElementById('conflicts-section');
  el.innerHTML = `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">Conflicts <span id="conflict-dot"></span></h2>
        <div class="caption panel-sub" id="conflict-sub">ALT superpositions · model invoked only when no rule applies</div>
      </div>
    </div>
    <div class="panel-body">
      <div id="conflict-list"></div>
    </div>`;
}

export async function updateConflicts() {
  const list = document.getElementById('conflict-list');
  const sub = document.getElementById('conflict-sub');
  const dot = document.getElementById('conflict-dot');
  if (!list) return;
  const conflicts = await findConflicts();
  const open = conflicts.filter(c => !c.resolved);
  sub.textContent = `${open.length} open · ${conflicts.length - open.length} adjudicated`;
  dot.innerHTML = open.length ? `<span class="conflict-indicator">${open.length}</span>` : '';

  if (!conflicts.length) {
    list.innerHTML = `<div class="empty quiet">No ALT conflicts in the log.</div>`;
    return;
  }
  list.innerHTML = conflicts.map(renderConflict).join('');
}

function renderConflict(c) {
  const resolved = c.resolved;
  return `<div class="conflict-row ${resolved ? 'resolved' : ''}">
    <div class="conflict-head">
      <div>
        <div class="mono" style="font-size:11px;color:var(--ink-faint);">target ${shortHash(c.target)}</div>
        <div class="conflict-target">${escape(c.target_form || '(unnamed)')}</div>
      </div>
      ${resolved ? '<span class="tag">adjudicated</span>' : '<span class="tag tag-warn">superposition</span>'}
    </div>
    <div class="conflict-values">
      ${c.candidates.map((v, i) => `
        <div class="candidate">
          <div class="cand-val mono">${escape(JSON.stringify(v.value))}</div>
          <div class="caption mute">${escape(v.source)} · ${new Date(v.timestamp).toLocaleString()}${v.provenance?.confidence != null ? ' · conf '+(v.provenance.confidence*100|0)+'%' : ''}</div>
          ${!resolved ? `<button class="btn btn-small btn-ghost" onclick="window.__ui.adjudicate('${c.target}', ${i}, 'user')">pick</button>` : ''}
        </div>`).join('')}
    </div>
    ${!resolved ? `<div class="conflict-actions">
      <button class="btn btn-small btn-primary" onclick="window.__ui.adjudicate('${c.target}', -1, 'model')">adjudicate via model</button>
      <button class="btn btn-small btn-ghost" onclick="window.__ui.tryRuleAdjudication('${c.target}')">try rules</button>
      <button class="btn btn-small btn-ghost" onclick="window.__ui.keepBoth('${c.target}')">keep both</button>
    </div>` : ''}
  </div>`;
}

/* ═══ REC PROPOSALS ═══════════════════════════════════════════════════ */
function renderProposals() {
  const el = document.getElementById('rec-section');
  el.innerHTML = `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">REC proposals</h2>
        <div class="caption panel-sub" id="rec-sub">Frame-change suggestions surfaced by the fold · never auto-applied</div>
      </div>
    </div>
    <div class="panel-body">
      <div id="rec-list"></div>
    </div>`;
}

export function pushProposal(p) {
  if (state.dismissedProposalIds.has(p.id)) return;
  state.proposals = [p, ...state.proposals.filter(q => q.id !== p.id)].slice(0, 20);
  updateProposals();
  toast(`REC proposal: ${p.kind}`);
}

export function updateProposals() {
  const sub = document.getElementById('rec-sub');
  const list = document.getElementById('rec-list');
  if (!list) return;
  const active = state.proposals.filter(p => !state.dismissedProposalIds.has(p.id));
  sub.textContent = active.length
    ? `${active.length} pending proposal${active.length===1?'':'s'} · review and accept or reject`
    : 'No pending proposals';
  if (!active.length) {
    list.innerHTML = `<div class="empty quiet">No frame-change proposals at this time. The fold scheduler scans every 45 seconds.</div>`;
    return;
  }
  list.innerHTML = active.map(p => `
    <div class="proposal">
      <div class="proposal-head">
        <span class="tag tag-${p.kind==='conflict-rate'?'warn':'info'}">${p.kind}</span>
        <span class="caption mute">${new Date(p.created_at).toLocaleTimeString()}</span>
      </div>
      <div class="proposal-body">${escape(p.suggestion)}</div>
      <div class="proposal-evidence caption mute">
        class: ${escape(p.target_class)} · n=${p.sample_size}${p.hit_rate != null ? ' · hit rate '+(p.hit_rate*100|0)+'%' : ''}${p.observed_ratio != null ? ' · conflict ratio '+(p.observed_ratio*100|0)+'%' : ''}
      </div>
      <div class="proposal-actions">
        <button class="btn btn-small btn-primary" onclick="window.__ui.acceptProposal('${p.id}')">Accept</button>
        <button class="btn btn-small btn-ghost" onclick="window.__ui.dismissProposal('${p.id}')">Dismiss</button>
      </div>
    </div>`).join('');
}

/* ═══ FOOTER ══════════════════════════════════════════════════════════ */
function renderFooter() {
  const el = document.getElementById('compute-footer');
  el.innerHTML = `
    <div class="footer-inner">
      <div class="metric-row" id="metric-row"></div>
      <div class="caption" style="margin-top:6px;opacity:0.5;">EO Local v1 · nine operators · twenty-seven cells · one closed algebra</div>
    </div>`;
}

export async function updateFooter() {
  const row = document.getElementById('metric-row');
  if (!row) return;
  const m = await getMetrics();
  const s = await summary();
  const est = await storageEstimate();
  const storageMB = est && est.usage ? (est.usage / 1024 / 1024).toFixed(2) : '—';
  const totalTokens = m.modelTokensIn + m.modelTokensOut;
  row.innerHTML = `
    <span class="mt"><span class="lab">events</span><span class="val">${s.total}</span></span>
    <span class="mt"><span class="lab">heuristic</span><span class="val">${m.heuristicCalls}</span></span>
    <span class="mt"><span class="lab">model calls</span><span class="val">${m.modelCalls}</span></span>
    <span class="mt"><span class="lab">horizon</span><span class="val">${m.horizonQueries}</span></span>
    <span class="mt"><span class="lab">tokens</span><span class="val">${totalTokens}</span></span>
    <span class="mt"><span class="lab">NUL gates</span><span class="val">${m.nulGates}</span></span>
    <span class="mt enforced"><span class="lab">GPU</span><span class="val">0</span></span>
    <span class="mt enforced"><span class="lab">network</span><span class="val">${m.modelCalls}</span></span>
    <span class="mt"><span class="lab">storage</span><span class="val">${storageMB} MB</span></span>`;
}

/* ═══ TOAST ═══════════════════════════════════════════════════════════ */
function renderToastContainer() {
  const el = document.getElementById('toast-container');
  if (el) el.innerHTML = '';
}
export function toast(msg, kind = 'info', ms = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => { t.classList.add('fade'); setTimeout(() => t.remove(), 300); }, ms);
}

/* ═══ HELPERS ═════════════════════════════════════════════════════════ */
function renderSPO(spo, compact = false) {
  if (!spo || (!spo.s && !spo.p && !spo.o)) return '';
  const cls = compact ? 'spo-triple compact' : 'spo-triple';
  return `<div class="${cls}">
    ${spo.s ? `<span class="spo-s">${escape(spo.s)}</span>` : ''}
    ${spo.p ? `<span class="spo-arrow">▸</span><span class="spo-p">${escape(spo.p)}</span>` : ''}
    ${spo.o ? `<span class="spo-arrow">▸</span><span class="spo-o">${escape(spo.o)}</span>` : ''}
  </div>`;
}

function renderNotation(ev) {
  const op = OPS[ev.operator];
  if (!op) return '';
  const res = ev.resolution_name || resolutionFor(ev.mode, ev.object);
  const site = ev.site_name || siteFor(ev.domain, ev.object);
  return `<span class="notation"><span style="color:${op.color};font-weight:600;">${ev.operator}</span><span class="mute">(</span><span>${escape(res)}</span><span class="mute">, </span><span>${escape(site)}</span><span class="mute">)</span></span>`;
}

function escape(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ═══ EXPORTED UI STATE ACTIONS ═══════════════════════════════════════ */
export const ui = {
  async classify() {
    await handleClassify();
  },
  async seed() {
    try {
      setIntakeStatus('Loading seed events…', 'info');
      const n = await loadSeeds();
      setIntakeStatus('', null);
      toast(`${n} seed events loaded.`, 'info');
      await ui.refresh?.();
    } catch(e) {
      setIntakeStatus(`Seed failed: ${e.message}`, 'error');
    }
  },
  async clearLog() {
    if (!confirm('Clear the entire log, all anchors, edges, frames, rules, and metrics? This cannot be undone.')) return;
    await clearAll();
    state.proposals = [];
    state.dismissedProposalIds.clear();
    document.getElementById('last-result').innerHTML = '';
    toast('Log cleared.', 'info');
    await ui.refresh?.();
  },
  toggleSettings() {
    const b = document.getElementById('settings-block');
    b?.classList.toggle('hidden');
  },
  saveKey() {
    const v = document.getElementById('api-key-input').value.trim();
    setApiKey(v);
    document.getElementById('settings-block').classList.add('hidden');
    toast(v ? 'Model key saved locally.' : 'Key cleared.', 'info');
  },
  setOperatorFilter(op) {
    state.filter.operator = state.filter.operator === op ? null : op;
    ui.refresh?.();
  },
  setSiteFilter(site) {
    state.filter.site = state.filter.site === site ? null : site;
    ui.refresh?.();
  },
  setResolutionFilter(res) {
    state.filter.resolution = state.filter.resolution === res ? null : res;
    ui.refresh?.();
  },
  clearFilter(k) {
    state.filter[k] = null;
    ui.refresh?.();
  },
  clearAllFilters() {
    state.filter = { operator: null, object: null, site: null, resolution: null, text: '' };
    document.getElementById('stream-search').value = '';
    ui.refresh?.();
  },
  toggleEvent(id) {
    state.expandedEventId = state.expandedEventId === id ? null : id;
    updateStream();
  },
  async adjudicate(targetHash, candidateIdx, via) {
    const conflicts = await findConflicts();
    const c = conflicts.find(x => x.target === targetHash);
    if (!c) return toast('Conflict no longer active.', 'info');
    let winnerIdx = candidateIdx;
    let reason = 'user choice';
    let agent = 'user';
    let conf = 1.0;
    if (via === 'model') {
      if (!hasApiKey()) return toast('Set a model key in Intake settings first.', 'error');
      try {
        const result = await modelAdjudicate(c.target_form, c.candidates);
        winnerIdx = result.winnerIndex;
        reason = result.reason;
        conf = result.confidence;
        agent = 'model';
        await updateMetrics({ modelCalls: 1, modelTokensIn: result.tokensIn, modelTokensOut: result.tokensOut });
      } catch(e) {
        return toast('Model adjudication failed: ' + (e.message || e), 'error');
      }
    }
    const winner = c.candidates[winnerIdx];
    const supEvent = {
      uuid: uuidv7(),
      ts: new Date().toISOString(),
      op_code: 8,
      operator: 'SUP',
      target: c.target,
      target_form: c.target_form,
      operand: winner.value,
      spo: { s: agent, p: 'adjudicated', o: String(winner.value) },
      mode: 'Relating',
      domain: 'Significance',
      object: 'Entity',
      site: 8, site_name: 'Lens',
      resolution: 5, resolution_name: 'Binding',
      frame: 'default',
      agent,
      clause: `Adjudication: ${JSON.stringify(winner.value)} selected over alternatives.`,
      confidence: conf,
      rationale: reason,
      provenance: { source: agent, path: 'sup', winner_event: winner.event_uuid }
    };
    await appendEvent(supEvent);
    await updateMetrics({ conflictsAdjudicated: 1 });
    toast(`Adjudicated via ${agent}: ${String(winner.value).slice(0,40)}`, 'info');
    await ui.refresh?.();
  },
  async tryRuleAdjudication(targetHash) {
    const conflicts = await findConflicts();
    const c = conflicts.find(x => x.target === targetHash);
    if (!c) return;
    const result = await tryRules({ hash: c.target, form: c.target_form }, c.candidates);
    if (!result) return toast('No installed rule matches this target.', 'info');
    const winner = c.candidates[result.winnerIndex];
    await appendEvent({
      uuid: uuidv7(), ts: new Date().toISOString(), op_code: 8, operator: 'SUP',
      target: c.target, target_form: c.target_form, operand: winner.value,
      spo: { s: 'rule', p: 'adjudicated', o: String(winner.value) },
      mode: 'Relating', domain: 'Significance', object: 'Entity',
      site: 8, site_name: 'Lens', resolution: 5, resolution_name: 'Binding',
      frame: 'default', agent: 'rule',
      clause: `Rule ${result.ruleStrategy} resolved: ${JSON.stringify(winner.value)}`,
      confidence: 1.0, rationale: result.reason,
      provenance: { source: 'rule', rule_id: result.ruleId, path: 'sup' }
    });
    await updateMetrics({ conflictsAdjudicated: 1 });
    toast(`Resolved by rule: ${result.ruleStrategy}`, 'info');
    await ui.refresh?.();
  },
  async keepBoth(targetHash) {
    // No event written — the superposition simply remains held.
    toast('Superposition retained.', 'info');
  },
  async acceptProposal(id) {
    const p = state.proposals.find(x => x.id === id);
    if (!p) return;
    if (p.rule_proposal) {
      try {
        const rule = await installRule({ ...p.rule_proposal, installedBy: 'user-rec' });
        // Write the REC event
        const anchor = makeAnchor(`rule:${rule.strategy}:${rule.id.slice(0,8)}`);
        await appendEvent({
          uuid: uuidv7(), ts: new Date().toISOString(), op_code: 9, operator: 'REC',
          target: anchor.hash, target_form: anchor.form,
          operand: rule.id,
          spo: { s: 'fold', p: 'installed', o: rule.description },
          mode: 'Generating', domain: 'Significance', object: 'Pattern',
          site: 9, site_name: 'Paradigm', resolution: 9, resolution_name: 'Composing',
          frame: 'default', agent: 'user',
          clause: `REC: install rule "${rule.description}"`,
          confidence: 1.0, rationale: p.suggestion,
          provenance: { source: 'user', proposal_id: id, rule_id: rule.id, path: 'rec' }
        });
        await updateMetrics({ recProposalsAccepted: 1 });
        toast(`Rule installed: ${rule.description}`, 'info');
      } catch(e) {
        toast(`Install failed: ${e.message}`, 'error');
      }
    } else {
      toast('Proposal accepted (no rule to install).', 'info');
    }
    state.dismissedProposalIds.add(id);
    await ui.refresh?.();
  },
  async dismissProposal(id) {
    state.dismissedProposalIds.add(id);
    await updateMetrics({ recProposalsRejected: 1 });
    updateProposals();
  }
};

// Expose to inline onclick handlers
if (typeof window !== 'undefined') window.__ui = ui;

/* ═══ ROUTER ═══ called by app.js after every mutation ══════════════ */
export async function refreshAll() {
  await updateEffBadge();
  await updateLattice();
  await updateStream();
  await updateConflicts();
  await updateProposals();
  await updateFooter();
}

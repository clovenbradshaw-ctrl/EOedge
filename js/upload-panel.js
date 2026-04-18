// ══════════════════════════════════════════════════════════════════════
// upload-panel.js — the Uploads tab
//
// A projection over upload-log. Left rail lists uploaded documents,
// selecting one shows nine stage cards in helix order with live status.
// The panel proves the document was read in dependency order — you can
// see SIG complete before INS, INS before SEG, and so on.
// ══════════════════════════════════════════════════════════════════════

import { OPS } from './ops.js';
import { STAGES, PREREQS } from './upload-pipeline.js';
import { listDocs, getDoc, subscribe as subUpload, clearDoc } from './upload-log.js';

const state = {
  selectedDocId: null
};

let _rootEl = null;
let _subscribed = false;

export function initUploadPanel() {
  _rootEl = document.getElementById('uploads-section');
  if (!_rootEl) return;
  _rootEl.innerHTML = shellHTML();
  if (!_subscribed) {
    subUpload(() => render());
    _subscribed = true;
  }
  render();
}

export function focusDoc(doc_id) {
  state.selectedDocId = doc_id;
  render();
}

function shellHTML() {
  return `
    <div class="panel-head">
      <div>
        <h2 class="panel-title">Uploads</h2>
        <div class="caption panel-sub">Nine stages in helix order · prereq-gated · append-only · per-document</div>
      </div>
    </div>
    <div class="panel-body">
      <div class="uploads-layout">
        <div class="uploads-rail" id="uploads-rail"></div>
        <div class="uploads-detail" id="uploads-detail"></div>
      </div>
    </div>`;
}

function render() {
  if (!_rootEl) return;
  const docs = listDocs();
  renderRail(docs);
  if (state.selectedDocId && !docs.find(d => d.doc_id === state.selectedDocId)) {
    state.selectedDocId = null;
  }
  if (!state.selectedDocId && docs.length) state.selectedDocId = docs[0].doc_id;
  renderDetail(state.selectedDocId ? getDoc(state.selectedDocId) : null);
}

function renderRail(docs) {
  const el = document.getElementById('uploads-rail');
  if (!el) return;
  if (!docs.length) {
    el.innerHTML = `<div class="empty quiet">Drop a document into the chat to see the helix run.</div>`;
    return;
  }
  el.innerHTML = docs.map(d => {
    const done = Object.values(d.stages).filter(s => s.status === 'done' || s.status === 'cached').length;
    const total = STAGES.length;
    const pct = Math.round(100 * done / total);
    const failing = Object.values(d.stages).some(s => s.status === 'failed');
    const cls = d.doc_id === state.selectedDocId ? 'sel' : '';
    const statusCls = failing ? 'failed' : (d.overall === 'done' ? 'done' : 'running');
    return `<button class="upload-card ${cls} ${statusCls}" data-doc-id="${escapeHTML(d.doc_id)}">
      <div class="uc-name">${escapeHTML(d.name)}</div>
      <div class="uc-meta">
        <span class="mono">${formatBytes(d.size_bytes)}</span>
        <span class="uc-mode">${escapeHTML(d.mode)}</span>
      </div>
      <div class="uc-ring">
        <div class="uc-ring-fill" style="width:${pct}%"></div>
      </div>
      <div class="caption uc-state">${done}/${total} stages${failing ? ' · FAILED' : ''}</div>
    </button>`;
  }).join('');

  el.querySelectorAll('[data-doc-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.selectedDocId = btn.getAttribute('data-doc-id');
      render();
    });
  });
}

function renderDetail(doc) {
  const el = document.getElementById('uploads-detail');
  if (!el) return;
  if (!doc) {
    el.innerHTML = `<div class="empty quiet">No document selected.</div>`;
    return;
  }

  if (doc.mode === 'llm-only') {
    el.innerHTML = `
      <div class="upload-header">
        <div>
          <div class="upload-name">${escapeHTML(doc.name)}</div>
          <div class="caption mute">${formatBytes(doc.size_bytes)} · ${escapeHTML(doc.mime || 'unknown')} · llm-only mode</div>
        </div>
        <button class="btn btn-small btn-ghost" data-remove="${escapeHTML(doc.doc_id)}">forget</button>
      </div>
      <div class="llm-only-banner">
        <div class="llm-only-title">LLM-only mode · helix bypassed</div>
        <div class="caption mute">Text was extracted and handed to the model. No NUL gate, no SIG, no INS … no stage artifacts. Flip the toggle back to EO-pipeline to see the nine stages.</div>
      </div>`;
    wireRemove();
    return;
  }

  const cards = STAGES.map(stage => renderStageCard(stage, doc.stages[stage])).join('');
  el.innerHTML = `
    <div class="upload-header">
      <div>
        <div class="upload-name">${escapeHTML(doc.name)}</div>
        <div class="caption mute">${formatBytes(doc.size_bytes)} · ${escapeHTML(doc.mime || 'unknown')} · ${escapeHTML(doc.overall)}</div>
      </div>
      <button class="btn btn-small btn-ghost" data-remove="${escapeHTML(doc.doc_id)}">forget</button>
    </div>
    <ol class="helix-stack">${cards}</ol>`;
  wireRemove();
  wireExpands();
}

function wireRemove() {
  document.querySelectorAll('[data-remove]').forEach(b => {
    b.addEventListener('click', () => {
      clearDoc(b.getAttribute('data-remove'));
    });
  });
}

function wireExpands() {
  document.querySelectorAll('[data-expand]').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.stage-card');
      if (card) card.classList.toggle('open');
    });
  });
}

function renderStageCard(stage, s) {
  const op = OPS[stage];
  const glyph = op?.glyph || '·';
  const color = op?.color || '#8A8175';
  const tint = op?.tint || '#E8E2D6';
  const statusChip = renderStatusChip(s.status);
  const duration = s.duration_ms ? `${s.duration_ms}ms` : (s.status === 'running' ? '…' : '');
  const persists = s.persists ? 'durable' : 'ephemeral';
  const prereqLine = s.prereqs.length ? `prereq: ${s.prereqs.join(', ')}` : 'prereq: —';

  return `<li class="stage-card ${s.status}" data-stage="${stage}">
    <button class="stage-head" data-expand>
      <span class="stage-glyph" style="background:${tint};color:${color};">${glyph}</span>
      <div class="stage-meta">
        <div class="stage-line">
          <span class="stage-name" style="color:${color};">${stage}</span>
          <span class="stage-sub">${escapeHTML(op?.name || '')}</span>
          ${statusChip}
        </div>
        <div class="stage-summary">${escapeHTML(s.summary || '—')}</div>
        <div class="caption stage-meta-line">${prereqLine} · ${persists} · ${duration}</div>
      </div>
      <span class="stage-expand">▸</span>
    </button>
    <div class="stage-body">${renderStageBody(stage, s)}</div>
  </li>`;
}

function renderStatusChip(status) {
  const map = {
    pending: ['pending', 'neutral'],
    running: ['running…', 'running'],
    done: ['done', 'ok'],
    cached: ['cached', 'ok'],
    skipped: ['skipped', 'neutral'],
    failed: ['failed', 'err']
  };
  const [label, cls] = map[status] || ['?', 'neutral'];
  return `<span class="chip chip-${cls}">${label}</span>`;
}

function renderStageBody(stage, s) {
  if (s.status === 'pending') {
    return `<div class="stage-waiting caption mute">Waiting on prereq(s): ${s.prereqs.join(', ') || '—'}</div>`;
  }
  if (s.status === 'failed') {
    return `<div class="stage-err">Error: ${escapeHTML(s.error || 'unknown')}</div>`;
  }
  const a = s.artifact || {};
  switch (stage) {
    case 'NUL':
      return `<dl class="kv">
        <dt>language</dt><dd>${escapeHTML(a.language || '')}</dd>
        <dt>encoding</dt><dd>${escapeHTML(a.encoding || '')}</dd>
        <dt>source type</dt><dd>${escapeHTML(a.source_type || '')}</dd>
        <dt>size</dt><dd>${a.size_bytes || 0} bytes · ${a.char_count || 0} chars</dd>
        <dt>assumptions set aside</dt><dd>${(a.assumptions_set_aside || []).map(x => `• ${escapeHTML(x)}`).join('<br>')}</dd>
      </dl>`;
    case 'SIG':
      return `<dl class="kv">
        <dt>clauses</dt><dd>${a.clause_count ?? '—'}</dd>
        <dt>sentences</dt><dd>${a.sentence_count ?? '—'}</dd>
        <dt>attention markers</dt><dd>${(a.attention_markers || []).length}</dd>
      </dl>
      ${(a.attention_markers || []).slice(0, 8).map(m => `<div class="mono small">[${m.clause_idx}] ${m.operator} · ${(m.confidence*100|0)}%</div>`).join('')}`;
    case 'INS':
      return `<div class="caption mute">${a.count} candidate entities (showing first ${Math.min(a.count, 40)})</div>
        <ol class="entity-list">${(a.sample || []).map(e =>
          `<li><span class="mono">${escapeHTML(e.form)}</span> <span class="caption mute">× ${e.occurrences}</span></li>`
        ).join('')}</ol>`;
    case 'SEG':
      return `<dl class="kv">
        <dt>clauses</dt><dd>${a.boundaries?.clauses ?? 0}</dd>
        <dt>sentences</dt><dd>${a.boundaries?.sentences ?? 0}</dd>
        <dt>paragraphs</dt><dd>${a.boundaries?.paragraphs ?? 0}</dd>
        <dt>predicate slots</dt><dd>${(a.predicate_slot_anchors || []).length}</dd>
      </dl>
      ${(a.predicate_slot_anchors || []).slice(0, 8).map(p => `<div class="mono small">${p.ps} ${escapeHTML(p.predicate)}</div>`).join('')}`;
    case 'CON':
      return `<div class="caption mute">${a.count} proposition edges (showing first ${Math.min(a.count, 40)})</div>
        <ol class="edge-list">${(a.sample || []).map(e =>
          `<li><span class="mono">${escapeHTML(e.s_form)}</span> <span class="edge-p">▸ ${escapeHTML(e.p)} ▸</span> <span class="mono">${escapeHTML(e.o_form)}</span></li>`
        ).join('')}</ol>`;
    case 'SYN':
      return `<dl class="kv">
        <dt>merged entities</dt><dd>${a.merged_entities ?? 0}</dd>
        <dt>propositions</dt><dd>${a.proposition_count ?? 0}</dd>
      </dl>
      ${(a.hubs || []).length ? `<div class="caption mute">top hubs by degree</div>` : ''}
      ${(a.hubs || []).map(h => `<div class="mono small">${escapeHTML(h.form)} <span class="caption mute">in:${h.in} out:${h.out}</span></div>`).join('')}`;
    case 'DEF': {
      const ops = Object.entries(a.by_operator || {}).map(([k,v]) => `<span class="op-tag" style="background:${OPS[k]?.tint||'#eee'};color:${OPS[k]?.color||'#333'};">${k}:${v}</span>`).join(' ');
      const zeroWarn = (a.total_clauses > 0 && (a.events || []).length === 0)
        ? `<div class="stage-warn">No events logged despite ${a.total_clauses} clauses. ${a.failed ? a.failed + ' failed — classifier likely not configured (no API key, no on-device model).' : ''}${a.nul_gated ? ' ' + a.nul_gated + ' NUL-gated — the heuristic treated them as non-transformations.' : ''}</div>`
        : '';
      return `${zeroWarn}
        <dl class="kv">
          <dt>total clauses</dt><dd>${a.total_clauses ?? 0}</dd>
          <dt>events logged</dt><dd>${(a.events || []).length}</dd>
          <dt>NUL-gated</dt><dd>${a.nul_gated ?? 0}</dd>
          <dt>low-confidence</dt><dd>${a.low_confidence ?? 0}</dd>
          <dt>failed</dt><dd>${a.failed ?? 0}</dd>
        </dl>
        ${ops ? `<div class="op-tags">${ops}</div>` : ''}
        <ol class="event-thumb">${(a.events || []).slice(0, 20).map(e =>
          `<li><span class="op-tag small" style="background:${OPS[e.operator]?.tint||'#eee'};color:${OPS[e.operator]?.color||'#333'};">${e.operator}</span> <span class="small">${escapeHTML(e.clause)}</span></li>`
        ).join('')}</ol>`;
    }
    case 'EVA': {
      const h = a.stance_histogram || {};
      const total = a.total_classified || 0;
      const bars = Object.entries(h).map(([stance, n]) => {
        const pct = total > 0 ? Math.round(100 * n / total) : 0;
        const isBinding = stance === 'Binding';
        return `<div class="stance-row ${isBinding ? 'binding' : ''}">
          <span class="stance-name">${stance}</span>
          <div class="stance-bar"><div class="stance-fill" style="width:${pct}%"></div></div>
          <span class="stance-n mono">${n}</span>
        </div>`;
      }).join('');
      return `<div class="caption mute">${escapeHTML(a.downstream_budget_note || '')}</div>
        <div class="stance-grid">${bars}</div>`;
    }
    case 'REC':
      if ((a.count || 0) === 0) return `<div class="caption mute">No frame changes. The document did not restructure how prior stages should read it.</div>`;
      return `<ol class="frame-changes">${(a.frame_changes || []).map(fc =>
        `<li><strong>${escapeHTML(fc.kind)}</strong> — ${escapeHTML(fc.suggestion || '')}<div class="caption mute">${escapeHTML(fc.evidence || '')}</div></li>`
      ).join('')}</ol>`;
    default:
      return `<pre class="mono small">${escapeHTML(JSON.stringify(a, null, 2))}</pre>`;
  }
}

function formatBytes(n) {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(2)} MB`;
}

function escapeHTML(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

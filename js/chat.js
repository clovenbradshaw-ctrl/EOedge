// ══════════════════════════════════════════════════════════════════════
// chat.js — the chat surface
//
// Primary chat message loop. Compiles every user turn into an operator
// tree, executes, renders. Shows receipts on every response. Handles
// file drops through the same intake pipeline.
// ══════════════════════════════════════════════════════════════════════

import { compile, toNotation, toPretty } from './chat-compile.js';
import { execute } from './chat-execute.js';
import { render } from './chat-render.js';
import { ingestFile, attachDropZone } from './upload.js';
import { ensureCentroids, isReady as embedReady, isLoading as embedLoading } from './embeddings.js';
import { getMetrics, appendEvent, updateMetrics } from './store.js';
import { uuidv7 } from './anchor.js';
import {
  loadModel, isReady as localReady, isLoading as localLoading,
  hasOptedIn, hasWebGPU, listModels, getPreferredModel, setPreferredModel,
  currentModelLabel, onProgress as onLocalProgress
} from './local-model.js';
import { runTurn as agentRunTurn } from './agent.js';

/* ═══ State ═══════════════════════════════════════════════════════════ */

const _messages = [];            // { id, role, text, receipt?, tree?, ts, events?, nul?, adjudications?, mechanism? }
let _nextId = 1;
let _busy = false;
let _embedStatus = null;         // { label, progress } | null
let _localStatus = null;         // { phase, text, progress, error? } | null
let _onTurnComplete = null;

function newMessage(role, text, extras = {}) {
  const msg = { id: _nextId++, role, text, ts: new Date().toISOString(), ...extras };
  _messages.push(msg);
  return msg;
}

/* ═══ Public ══════════════════════════════════════════════════════════ */

export function initChat({ onTurnComplete } = {}) {
  _onTurnComplete = onTurnComplete;
  renderShell();
  pushSystemGreeting();
  pushLocalModelBanner();
  renderMessages();

  onLocalProgress((p) => {
    _localStatus = p;
    renderLocalBanner();
    if (p.phase === 'ready') {
      pushSystemMessage(`On-device AI ready · ${currentModelLabel()}. All chat runs locally from now on.`);
    } else if (p.phase === 'error') {
      pushSystemMessage(`Could not load on-device AI: ${p.text}. Chat falls back to retrieval-only mode.`, { error: true });
    }
  });

  // Auto-resume the model if the user opted in last session.
  if (hasOptedIn()) {
    hasWebGPU().then((ok) => {
      if (ok) startLocalLoad();
    });
  }

  // Kick off embedding load in background (best-effort — system works without it).
  // Cold loads download ~24 MB of model weights on first run, so be explicit
  // about what's happening instead of hiding it in a 10px status strip.
  const willBeCold = !hasCachedCentroids();
  let loadingMsgId = null;
  if (willBeCold) {
    loadingMsgId = newMessage('system',
      `Loading semantic model (MiniLM · ~24 MB, first run only). Cached locally after this. You can still chat — heuristic classification handles the meantime.`,
      { loading: true }
    ).id;
    renderMessages();
  }

  const startedAt = Date.now();
  ensureCentroids((label, progress) => {
    _embedStatus = { label, progress };
    renderStatusBar();
    if (loadingMsgId != null) {
      const m = _messages.find(x => x.id === loadingMsgId);
      if (m) {
        const pct = Math.round((progress || 0) * 100);
        m.text = `Loading semantic model · ${label} · ${pct}%`;
        renderMessages();
      }
    }
    if (progress >= 1) setTimeout(() => { _embedStatus = null; renderStatusBar(); }, 1500);
  }).then(() => {
    if (loadingMsgId != null) {
      const m = _messages.find(x => x.id === loadingMsgId);
      if (m) {
        const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        m.text = `Semantic model ready (${secs}s). Subsequent loads will be instant.`;
        m.loading = false;
      }
      renderMessages();
    }
  }).catch(err => {
    _embedStatus = { label: 'Embeddings offline · using heuristic', progress: 1 };
    renderStatusBar();
    if (loadingMsgId != null) {
      const m = _messages.find(x => x.id === loadingMsgId);
      if (m) {
        m.text = `Semantic refinement offline — heuristic classification is handling things. (${err?.message || err})`;
        m.loading = false;
      }
      renderMessages();
    }
    setTimeout(() => { _embedStatus = null; renderStatusBar(); }, 4000);
  });
}

function hasCachedCentroids() {
  try { return !!localStorage.getItem('eo-local-centroids-v1'); } catch(e) { return false; }
}

/** Programmatic message push — used by fold proposals, REC surfaces, etc. */
export function pushSystemMessage(text, extras = {}) {
  newMessage('system', text, extras);
  renderMessages();
  scrollToBottom();
}

export async function sendUser(text) {
  if (_busy) return;
  const clean = String(text || '').trim();
  if (!clean) return;
  newMessage('user', clean);
  renderMessages();
  scrollToBottom();
  await respondTo(clean);
  renderMessages();
  scrollToBottom();
  _onTurnComplete?.();
}

/* ═══ Core turn ═══════════════════════════════════════════════════════ */

async function respondTo(userText) {
  _busy = true;
  setComposerBusy(true);
  try {
    if (localReady()) {
      return await respondViaAgent(userText);
    }
    return await respondViaPipeline(userText);
  } catch(e) {
    console.error('respondTo error', e);
    newMessage('assistant', `Something broke while handling that turn. (${e.message || e})`, { error: true });
  } finally {
    _busy = false;
    setComposerBusy(false);
  }
}

async function respondViaAgent(userText) {
  const history = _messages
    .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.error))
    .slice(-12)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text || '' }));
  // Drop the just-added user turn (it's the current input)
  if (history.length && history[history.length-1].content === userText) history.pop();

  const result = await agentRunTurn(userText, history);
  const msg = newMessage('assistant', result.chat || '...', {
    mechanism: result.mechanism || null,
    warnings: result.warnings || [],
    via: 'local',
    usage: result.usage
  });
  return msg;
}

async function respondViaPipeline(userText) {
  const { tree, rationale } = await compile(userText, { useEmbeddings: embedReady() });
  const result = await execute(tree);
  const rendered = render(tree, result);
  // Adapt the legacy pipeline output into the chat+mechanism shape.
  const mechanism = mechanismFromLegacy(rendered, result);
  const msg = newMessage('assistant', rendered.text, {
    receipt: rendered.receipt,
    tree,
    rationale,
    events: rendered.events,
    edges: rendered.edges,
    adjudications: rendered.adjudications,
    nul: rendered.nul,
    mechanism,
    via: 'pipeline'
  });
  return msg;
}

function mechanismFromLegacy(rendered, result) {
  const events = rendered?.events || result?.events || [];
  if (!events.length) return null;
  return {
    lookup: rendered?.receipt?.notes
      ? `${rendered.receipt.notes}.`
      : `Pulled ${events.length} record${events.length===1?'':'s'} from the log.`,
    result_count: events.length,
    records: events.map(e => ({
      id: e.uuid,
      label: `${e.spo?.s || e.target_form || '?'} ${e.spo?.p || ''} ${e.spo?.o || e.operand || ''}`.trim(),
      when: humanTime(e.ts),
      where: e.site_name || '',
      operator: e.operator,
      clause: e.clause || ''
    }))
  };
}

function humanTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `today ${d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}`;
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ═══ File ingest ═════════════════════════════════════════════════════ */

async function handleFiles(files) {
  for (const file of files) {
    const startId = newMessage('system', `📎 Uploading ${file.name}…`).id;
    try {
      const result = await ingestFile(file, (p) => {
        const m = _messages.find(x => x.id === startId);
        if (!m) return;
        if (p.phase === 'reading')       m.text = `📎 Reading ${p.file}…`;
        else if (p.phase === 'classifying') m.text = `📎 Classifying ${p.file} · ${p.chars} chars`;
        else if (p.phase === 'done')     m.text = `📎 ${p.file} · ${p.emitted} events logged · ${p.nul_gated} gated${p.failed?` · ${p.failed} failed`:''}`;
        renderMessages();
      });
      // Add a small summary turn
      newMessage('assistant', summarizeIngest(result), { file_ingest: result });
    } catch(e) {
      newMessage('system', `📎 ${file.name} failed: ${e.message}`, { error: true });
    }
    renderMessages();
    scrollToBottom();
  }
  _onTurnComplete?.();
}

function summarizeIngest(r) {
  return `Ingested "${r.file}" — ${r.emitted} events added. Ask me about it.`;
}

/* ═══ Rendering ═══════════════════════════════════════════════════════ */

function renderShell() {
  const el = document.getElementById('chat-section');
  if (!el) return;
  el.innerHTML = `
    <div class="chat-shell">
      <div id="chat-status" class="chat-status"></div>
      <div id="local-banner" class="local-banner"></div>
      <div id="chat-messages" class="chat-messages"></div>
      <div id="chat-composer-row" class="chat-composer-row">
        <div class="chat-dropzone" id="chat-dropzone">
          <button class="btn-upload" id="chat-upload-btn" title="Upload a document" aria-label="Upload">📎</button>
          <input type="file" id="chat-file-input" multiple hidden accept=".txt,.md,.markdown,.csv,.json,.ndjson,.jsonl,.log">
          <textarea id="chat-input" class="chat-input" rows="1" placeholder="Ask something, state a fact, or drop a document here…"></textarea>
          <button id="chat-send-btn" class="btn btn-primary chat-send">Send ↵</button>
        </div>
        <div class="chat-hints">
          <span class="hint">⌘↵ to send · drop files here · Esc to unfocus</span>
        </div>
      </div>
    </div>`;

  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  const uploadBtn = document.getElementById('chat-upload-btn');
  const fileInput = document.getElementById('chat-file-input');
  const dropzone = document.getElementById('chat-dropzone');

  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(180, input.scrollHeight) + 'px';
  });
  // Key handlers
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendClicked(); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) { e.preventDefault(); sendClicked(); }
    else if (e.key === 'Escape') input.blur();
  });
  sendBtn.addEventListener('click', sendClicked);
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) handleFiles(files);
    fileInput.value = '';
  });
  attachDropZone(dropzone, handleFiles);
}

function sendClicked() {
  const input = document.getElementById('chat-input');
  const text = input.value;
  input.value = '';
  input.style.height = 'auto';
  sendUser(text);
}

function setComposerBusy(busy) {
  const btn = document.getElementById('chat-send-btn');
  const input = document.getElementById('chat-input');
  if (btn) { btn.disabled = busy; btn.textContent = busy ? '…' : 'Send ↵'; }
  if (input) input.disabled = busy;
}

function renderStatusBar() {
  const el = document.getElementById('chat-status');
  if (!el) return;
  if (!_embedStatus) { el.innerHTML = ''; el.classList.remove('visible'); return; }
  el.classList.add('visible');
  const pct = Math.round((_embedStatus.progress || 0) * 100);
  el.innerHTML = `<div class="status-inner ${_embedStatus.error ? 'err' : ''}">
    <span>${escapeHTML(_embedStatus.label)}</span>
    <div class="status-bar"><div class="status-fill" style="width:${pct}%"></div></div>
  </div>`;
}

function renderMessages() {
  const el = document.getElementById('chat-messages');
  if (!el) return;
  el.innerHTML = _messages.map(renderMessage).join('');
  attachMessageHandlers();
}

function renderMessage(msg) {
  const tsL = new Date(msg.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const roleClass = msg.role === 'user' ? 'msg-user' : msg.role === 'system' ? 'msg-sys' : 'msg-asst';
  const errorClass = msg.error ? ' msg-err' : '';
  const nulClass = msg.nul ? ' msg-nul' : '';
  const loadingClass = msg.loading ? ' msg-loading' : '';
  const receiptHTML = msg.receipt ? renderReceipt(msg) : '';
  const adjHTML = msg.adjudications ? renderAdjudications(msg) : '';
  // Assistant turns get a mechanism panel. NULL is shown explicitly.
  const mechHTML = msg.role === 'assistant' && !msg.error ? renderMechanism(msg) : '';
  const warnHTML = msg.warnings && msg.warnings.length ? renderWarnings(msg) : '';
  const body = escapeHTML(msg.text).replace(/\n/g, '<br>');
  return `<div class="msg ${roleClass}${errorClass}${nulClass}${loadingClass}" data-msg-id="${msg.id}">
    <div class="msg-body">${body}</div>
    ${warnHTML}
    ${adjHTML}
    ${mechHTML}
    ${receiptHTML}
    <div class="msg-meta"><span class="msg-ts">${tsL}</span></div>
  </div>`;
}

function renderMechanism(msg) {
  const m = msg.mechanism;
  if (!m) {
    return `<div class="mech mech-null"><span class="mech-label">No data referenced</span></div>`;
  }
  const summary = `<span class="mech-lookup">${escapeHTML(m.lookup || '')}</span>`;
  const records = (m.records || []).slice(0, 50);
  const recordsHTML = records.length === 0 ? '' : `
    <ol class="mech-records">
      ${records.map(r => `
        <li class="mech-record" data-record-id="${escapeHTML(r.id || '')}">
          <div class="mech-record-label">${escapeHTML(r.label || '')}</div>
          <div class="mech-record-meta">
            ${r.when ? `<span class="mech-when">${escapeHTML(r.when)}</span>` : ''}
            ${r.where ? `<span class="mech-where">${escapeHTML(r.where)}</span>` : ''}
            ${r.operator ? `<span class="mech-op">${escapeHTML(r.operator)}</span>` : ''}
          </div>
          ${r.clause ? `<div class="mech-record-clause">"${escapeHTML(r.clause)}"</div>` : ''}
        </li>`).join('')}
    </ol>
    ${(m.records || []).length > records.length ? `<div class="mech-more">+${(m.records||[]).length - records.length} more</div>` : ''}
  `;
  return `<details class="mech">
    <summary>${summary}</summary>
    <div class="mech-body">${recordsHTML}</div>
  </details>`;
}

function renderWarnings(msg) {
  const items = msg.warnings.map(w => {
    if (w.startsWith('unsourced_number:')) return `Mentioned a number ("${w.split(':')[1]}") that's not in the records.`;
    if (w.startsWith('unsourced_date:'))   return `Mentioned a date ("${w.split(':')[1]}") that's not in the records.`;
    if (w === 'agent_loop_exhausted')      return `Hit my reasoning limit on this one.`;
    return w;
  });
  return `<div class="msg-warnings">${items.map(t => `<div class="msg-warning">⚠ ${escapeHTML(t)}</div>`).join('')}</div>`;
}

function renderReceipt(msg) {
  const r = msg.receipt;
  if (!r) return '';
  const costBits = [];
  if (r.events_scanned) costBits.push(`${r.events_scanned} scanned`);
  if (r.events_returned) costBits.push(`${r.events_returned} matched`);
  if (r.model_calls) costBits.push(`${r.model_calls} model · ${r.tokens} tokens`);
  else costBits.push('0 tokens');
  const costLine = costBits.join(' · ');
  return `<details class="receipt">
    <summary>${escapeHTML(r.notation)} · <span class="receipt-cost">${escapeHTML(costLine)}</span></summary>
    <div class="receipt-body">
      <pre class="mono">${escapeHTML(toPretty(msg.tree))}</pre>
      ${r.notes ? `<div class="receipt-notes">${escapeHTML(r.notes)}</div>` : ''}
    </div>
  </details>`;
}

function renderAdjudications(msg) {
  if (!msg.adjudications) return '';
  return `<div class="adjudications">${msg.adjudications.map((a, ai) => `
    <div class="adj-row">
      <div class="adj-target">${escapeHTML(a.target || '')}</div>
      <div class="adj-cands">
        ${a.candidates.map((c, ci) => `
          <button class="adj-btn" data-adj-pick data-msg-id="${msg.id}" data-adj-idx="${ai}" data-cand-idx="${ci}">
            ${escapeHTML(JSON.stringify(c.value))}
            <span class="adj-src">${escapeHTML(c.source || '?')}</span>
          </button>`).join('')}
      </div>
    </div>`).join('')}</div>`;
}

function attachMessageHandlers() {
  document.querySelectorAll('[data-adj-pick]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mid = +btn.getAttribute('data-msg-id');
      const ai = +btn.getAttribute('data-adj-idx');
      const ci = +btn.getAttribute('data-cand-idx');
      const msg = _messages.find(m => m.id === mid);
      if (!msg) return;
      const adj = msg.adjudications?.[ai];
      if (!adj) return;
      if (!adj.target_hash) {
        const row = btn.closest('.adj-row');
        if (row) row.innerHTML = `<div class="adj-resolved err">✗ Cannot adjudicate — target hash missing</div>`;
        return;
      }
      const winner = adj.candidates[ci];
      try {
        await appendEvent({
          uuid: uuidv7(),
          ts: new Date().toISOString(),
          op_code: 8,
          operator: 'EVA',
          target: adj.target_hash,
          target_form: adj.target,
          operand: winner.value,
          spo: { s: 'user', p: 'adjudicated', o: String(winner.value) },
          mode: 'Relating', domain: 'Significance', object: 'Entity',
          site: 8, site_name: 'Lens',
          resolution: 5, resolution_name: 'Binding',
          frame: 'default',
          agent: 'user',
          clause: `Adjudication from chat: ${JSON.stringify(winner.value)}`,
          confidence: 1.0,
          rationale: 'User pick',
          provenance: { source: 'chat', path: 'sup' }
        });
        await updateMetrics({ conflictsAdjudicated: 1 });
        // Mark adjudication resolved in our local message state so re-renders don't reset it
        adj.resolution = { winnerIndex: ci, reason: 'user pick', confidence: 1.0, via: 'chat' };
        const row = btn.closest('.adj-row');
        if (row) row.innerHTML = `<div class="adj-resolved">✓ ${escapeHTML(adj.target)} — ${escapeHTML(JSON.stringify(winner.value))}</div>`;
        _onTurnComplete?.();
      } catch(e) {
        const row = btn.closest('.adj-row');
        if (row) row.innerHTML = `<div class="adj-resolved err">✗ Failed: ${escapeHTML(e.message || String(e))}</div>`;
      }
    });
  });
}

function scrollToBottom() {
  const el = document.getElementById('chat-messages');
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

function pushSystemGreeting() {
  newMessage('system',
    `Ask a question, state a fact, or drop a document.

I classify every turn into the nine-operator space, run it against your log, and answer from structure when I can. Tap any response to see the operator expression that produced it.`);
  renderMessages();
}

function pushLocalModelBanner() {
  // Banner is rendered separately via renderLocalBanner() into #local-banner.
  // This function exists so the call site reads as part of the boot sequence.
  renderLocalBanner();
}

/* ═══ Local model banner ═══════════════════════════════════════════════ */

function renderLocalBanner() {
  const el = document.getElementById('local-banner');
  if (!el) return;

  if (localReady()) {
    el.innerHTML = `<div class="local-banner-row ready">
      <span class="dot ok"></span>
      <span>On-device AI · ${escapeHTML(currentModelLabel() || 'ready')}</span>
    </div>`;
    return;
  }

  if (_localStatus && (_localStatus.phase === 'download' || localLoading())) {
    const pct = Math.round((_localStatus.progress || 0) * 100);
    el.innerHTML = `<div class="local-banner-row loading">
      <span class="dot pending"></span>
      <div class="local-progress-text">${escapeHTML(_localStatus.text || 'Loading on-device AI…')}</div>
      <div class="local-progress-bar"><div class="local-progress-fill" style="width:${pct}%"></div></div>
    </div>`;
    return;
  }

  if (_localStatus && _localStatus.phase === 'error') {
    el.innerHTML = `<div class="local-banner-row err">
      <span class="dot err"></span>
      <span>On-device AI failed: ${escapeHTML(_localStatus.text || 'unknown error')}</span>
      <button class="local-banner-btn" id="local-retry-btn">Retry</button>
    </div>`;
    document.getElementById('local-retry-btn')?.addEventListener('click', startLocalLoad);
    return;
  }

  // Idle, opt-in pitch
  const opts = listModels().map(m =>
    `<option value="${escapeHTML(m.key)}" ${m.key === getPreferredModel() ? 'selected' : ''}>${escapeHTML(m.label)} · ~${m.sizeGB.toFixed(1)} GB</option>`
  ).join('');
  el.innerHTML = `<div class="local-banner-row idle">
    <div class="local-banner-msg">
      <strong>Enable on-device AI</strong>
      <span class="mute"> — one-time download, runs locally after that. Page works without it.</span>
    </div>
    <select id="local-model-select" class="local-model-select" aria-label="Choose model">${opts}</select>
    <button class="local-banner-btn primary" id="local-enable-btn">Enable</button>
  </div>`;
  document.getElementById('local-model-select')?.addEventListener('change', (e) => {
    setPreferredModel(e.target.value);
  });
  document.getElementById('local-enable-btn')?.addEventListener('click', startLocalLoad);
}

async function startLocalLoad() {
  if (localReady() || localLoading()) return;
  if (!(await hasWebGPU())) {
    _localStatus = { phase: 'error', text: 'WebGPU not available in this browser. Try a recent Chrome or Edge.', progress: 0, error: true };
    renderLocalBanner();
    return;
  }
  _localStatus = { phase: 'download', text: 'Starting download…', progress: 0 };
  renderLocalBanner();
  try {
    await loadModel(getPreferredModel());
    renderLocalBanner();
  } catch(e) {
    _localStatus = { phase: 'error', text: e.message || String(e), progress: 0, error: true };
    renderLocalBanner();
  }
}

/* ═══ Helpers ══════════════════════════════════════════════════════ */

function escapeHTML(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

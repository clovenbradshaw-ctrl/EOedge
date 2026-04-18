// ══════════════════════════════════════════════════════════════════════
// app.js — orchestration
//
// Opens the store, starts the fold, initializes chat and the inspector
// drawer. The inspector drawer holds the existing six structural panels;
// chat is the primary surface users interact with.
// ══════════════════════════════════════════════════════════════════════

import { openDB, subscribe } from './store.js';
import { initUI, refreshAll, pushProposal } from './ui.js';
import { initChat, pushSystemMessage } from './chat.js';
import { start as startFold } from './fold.js';

let refreshPending = false;
function refresh() {
  if (refreshPending) return;
  refreshPending = true;
  queueMicrotask(async () => {
    refreshPending = false;
    try { await refreshAll(); } catch(e) { console.error('refresh error:', e); }
  });
}

async function main() {
  try {
    await openDB();
  } catch(e) {
    document.body.innerHTML = `<div style="padding:40px;font-family:serif;max-width:640px;margin:40px auto;line-height:1.6;">
      <h1 style="color:#B84A62;">Storage unavailable</h1>
      <p>EO Local requires OPFS. This browser session doesn't seem to allow it (private mode with strict settings, cross-origin iframe, or storage entirely disabled).</p>
      <p style="color:#666;font-size:14px;font-family:monospace;">${e.message || e}</p>
    </div>`;
    return;
  }

  // Chat first — the primary surface
  initChat({ onTurnComplete: refresh });

  // Inspector (formerly the whole app). Still renders the six panels.
  initUI({
    onClassify: refresh,
    onRefresh: refresh
  });

  // Wire inspector open/close
  wireInspector();
  wireTabs();

  // Store change subscription → refresh inspector surfaces
  subscribe(() => refresh());

  // Fold scheduler → surfaces REC proposals into the inspector, notifies via chat
  startFold((proposal) => {
    pushProposal(proposal);
    pushSystemMessage(`⚠️ Pattern detected: ${proposal.kind} on ${proposal.target_class}. Review in Inspector → REC.`, {
      proposal_id: proposal.id
    });
  });

  // Initial paint
  await refreshAll();

  // Service worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* non-fatal */ });
    });
  }

  console.log('%cEO Local %cchat · inspector · fold ready',
    'font-weight:600;color:#0A7E8C;', 'color:#666;');
}

function wireInspector() {
  const aside = document.getElementById('inspector');
  const scrim = document.getElementById('inspector-scrim');
  const openBtn = document.getElementById('btn-inspector');
  const closeBtn = document.getElementById('btn-inspector-close');
  const open = () => { aside.classList.add('open'); aside.setAttribute('aria-hidden', 'false'); };
  const close = () => { aside.classList.remove('open'); aside.setAttribute('aria-hidden', 'true'); };
  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  scrim?.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && aside.classList.contains('open')) close();
  });
}

function wireTabs() {
  document.querySelectorAll('.inspector-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-tab');
      document.querySelectorAll('.inspector-tabs .tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.toggle('active', p.getAttribute('data-tab-panel') === target);
      });
    });
  });
}

main();

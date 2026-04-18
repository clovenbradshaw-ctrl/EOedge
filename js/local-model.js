// ══════════════════════════════════════════════════════════════════════
// local-model.js — WebLLM wrapper
//
// Loads a quantized instruction model entirely in-browser via WebGPU.
// First load downloads ~1.5–2 GB from the MLC CDN; cached after that.
// Exposes a tiny chat-completion shim that mirrors the OpenAI-style
// {messages, tools} call the agent uses.
// ══════════════════════════════════════════════════════════════════════

const MODELS = {
  'qwen-3b':   { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',   label: 'Qwen 2.5 3B',   sizeGB: 1.9, backend: 'webllm' },
  'llama-3b':  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B',  sizeGB: 1.8, backend: 'webllm' },
  'qwen-1.5b': { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 1.5B', sizeGB: 1.0, backend: 'webllm' },
  'llama-1b':  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B',  sizeGB: 0.8, backend: 'webllm' },
  // MLX — Apple-silicon only, served via `mlx_lm.server`. WebLLM cannot load
  // these directly. Setup on the host:
  //   pip install mlx-lm
  //   mlx_lm.server --model mlx-community/Apertus-8B-Instruct-2509-8bit --port 8080
  // Then the browser talks to http://localhost:8080/v1/chat/completions.
  'apertus-8b-mlx': {
    id: 'mlx-community/Apertus-8B-Instruct-2509-8bit',
    label: 'Apertus 8B (MLX)',
    sizeGB: 8.0,
    backend: 'mlx',
    defaultEndpoint: 'http://localhost:8080/v1'
  }
};
const LS_MLX_ENDPOINT = 'eo-local-mlx-endpoint';

// WebLLM only accepts `tools` for a hand-picked set of function-calling
// checkpoints. Everything else — including all the lightweight Qwen/Llama
// instruct variants we ship — must emulate tool calls via prompt injection.
const NATIVE_TOOL_MODEL_IDS = new Set([
  'Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC',
  'Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC',
  'Hermes-2-Pro-Mistral-7B-q4f16_1-MLC',
  'Hermes-3-Llama-3.1-8B-q4f32_1-MLC',
  'Hermes-3-Llama-3.1-8B-q4f16_1-MLC'
]);
// EO does the heavy lifting (heuristic + centroid + rule pipeline), so the
// local model only sees hard residual cases (SYN synthesis, low-confidence
// intake). Default to the smallest competent quant — ~1 GB instead of ~1.9 GB.
const DEFAULT_KEY = 'qwen-1.5b';
const LS_PREF_KEY = 'eo-local-model-pref';
const LS_OPTED_IN = 'eo-local-model-opted-in';

let _engine = null;
let _loading = null;
let _modelKey = null;
let _progressListeners = new Set();
// Model IDs that claimed native tool support but were rejected by WebLLM at
// runtime — we demote them to prompt-based dispatch for the rest of the session.
const _demotedFromNative = new Set();

export function listModels() {
  return Object.entries(MODELS).map(([key, m]) => ({ key, ...m }));
}

export function getPreferredModel() {
  try { return localStorage.getItem(LS_PREF_KEY) || DEFAULT_KEY; } catch(e) { return DEFAULT_KEY; }
}

export function setPreferredModel(key) {
  if (!MODELS[key]) return;
  try { localStorage.setItem(LS_PREF_KEY, key); } catch(e) {}
}

export function hasOptedIn() {
  try { return localStorage.getItem(LS_OPTED_IN) === '1'; } catch(e) { return false; }
}

export function setOptedIn(v) {
  try { localStorage.setItem(LS_OPTED_IN, v ? '1' : ''); } catch(e) {}
}

export function isReady() {
  return !!_engine;
}

export function isLoading() {
  return !!_loading;
}

export function currentModelLabel() {
  return _modelKey ? MODELS[_modelKey]?.label : null;
}

export function currentModelKey() {
  return _modelKey;
}

export function currentBackend() {
  return _modelKey ? MODELS[_modelKey]?.backend : null;
}

export function getMLXEndpoint() {
  try {
    return localStorage.getItem(LS_MLX_ENDPOINT) || MODELS['apertus-8b-mlx'].defaultEndpoint;
  } catch(e) { return MODELS['apertus-8b-mlx'].defaultEndpoint; }
}

export function setMLXEndpoint(url) {
  try { localStorage.setItem(LS_MLX_ENDPOINT, url || ''); } catch(e) {}
}

export function supportsNativeTools() {
  if (!_modelKey) return false;
  const id = MODELS[_modelKey]?.id;
  if (!id) return false;
  if (_demotedFromNative.has(id)) return false;
  return NATIVE_TOOL_MODEL_IDS.has(id);
}

export function onProgress(listener) {
  _progressListeners.add(listener);
  return () => _progressListeners.delete(listener);
}

function emitProgress(p) {
  for (const l of _progressListeners) {
    try { l(p); } catch(e) {}
  }
}

export async function hasWebGPU() {
  if (!('gpu' in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch(e) { return false; }
}

export async function loadModel(key = getPreferredModel()) {
  if (_engine && _modelKey === key) return _engine;
  if (_loading && _modelKey === key) return _loading;
  if (!MODELS[key]) throw new Error(`Unknown model: ${key}`);

  setPreferredModel(key);
  setOptedIn(true);

  const backend = MODELS[key].backend;
  if (backend === 'mlx') {
    _loading = (async () => {
      // Ping the MLX server to verify the user has it running.
      const endpoint = getMLXEndpoint();
      emitProgress({ phase: 'download', text: `Connecting to MLX server at ${endpoint}…`, progress: 0.1 });
      try {
        const r = await fetch(endpoint.replace(/\/+$/,'') + '/models', { method: 'GET' });
        if (!r.ok) throw new Error(`MLX server at ${endpoint} returned ${r.status}. Run: pip install mlx-lm && mlx_lm.server --model ${MODELS[key].id} --port 8080`);
      } catch(e) {
        throw new Error(`No MLX server reachable at ${endpoint}. Run: pip install mlx-lm && mlx_lm.server --model ${MODELS[key].id} --port 8080 — then reload.`);
      }
      _engine = { backend: 'mlx', endpoint, modelId: MODELS[key].id };
      _modelKey = key;
      emitProgress({ phase: 'ready', text: `${MODELS[key].label} ready (MLX)`, progress: 1 });
      return _engine;
    })();
  } else {
    if (!(await hasWebGPU())) throw new Error('WebGPU not available in this browser.');
    _loading = (async () => {
      const webllm = await import('https://esm.run/@mlc-ai/web-llm@0.2.79');
      const modelId = MODELS[key].id;
      const engine = await webllm.CreateMLCEngine(modelId, {
        initProgressCallback: (p) => {
          emitProgress({
            phase: 'download',
            text: p.text || '',
            progress: typeof p.progress === 'number' ? p.progress : 0
          });
        }
      });
      _engine = engine;
      _modelKey = key;
      emitProgress({ phase: 'ready', text: `${MODELS[key].label} ready`, progress: 1 });
      return engine;
    })();
  }

  try {
    return await _loading;
  } catch(e) {
    _loading = null;
    emitProgress({ phase: 'error', text: e.message || String(e), progress: 0, error: true });
    throw e;
  } finally {
    _loading = null;
  }
}

export async function unloadModel() {
  if (_engine?.unload) {
    try { await _engine.unload(); } catch(e) {}
  }
  _engine = null;
  _modelKey = null;
  _demotedFromNative.clear();
}

/** Swap the active model. Unloads the current engine, then loads the new one. */
export async function switchModel(newKey) {
  if (!MODELS[newKey]) throw new Error(`Unknown model: ${newKey}`);
  if (_modelKey === newKey && _engine) return _engine;
  if (_loading) {
    // Wait for the in-flight load to settle before swapping.
    try { await _loading; } catch(e) { /* ignore */ }
  }
  await unloadModel();
  emitProgress({ phase: 'download', text: `Swapping to ${MODELS[newKey].label}…`, progress: 0 });
  return loadModel(newKey);
}

/**
 * Run a chat completion. messages is the OpenAI-style array.
 * If tools is provided, the model may emit tool calls.
 * Returns { content, tool_calls, usage }.
 */
export async function complete({ messages, tools, tool_choice = 'auto', temperature = 0.3, max_tokens = 512 }) {
  if (!_engine) throw new Error('Local model not loaded.');

  // MLX backend: OpenAI-compatible HTTP against the user's local mlx_lm.server.
  if (_engine.backend === 'mlx') {
    const body = {
      model: _engine.modelId,
      messages, temperature, max_tokens,
      stream: false
    };
    const url = _engine.endpoint.replace(/\/+$/,'') + '/chat/completions';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`MLX server error ${r.status}: ${await r.text().catch(() => '')}`);
    const resp = await r.json();
    const choice = resp.choices?.[0];
    const msg = choice?.message || {};
    return {
      content: msg.content || '',
      tool_calls: msg.tool_calls || null,
      finish_reason: choice?.finish_reason || '',
      usage: resp.usage || {}
    };
  }

  const req = { messages, temperature, max_tokens };
  const wantsTools = !!(tools && tools.length) && supportsNativeTools();
  if (wantsTools) {
    req.tools = tools;
    req.tool_choice = tool_choice;
  }
  let resp;
  try {
    resp = await _engine.chat.completions.create(req);
  } catch(e) {
    const msg = e?.message || String(e);
    // Safety net: if the selected model rejects the tools field, demote it
    // for the rest of the session and retry without tools.
    if (req.tools && /not supported for ChatCompletionRequest\.tools/i.test(msg)) {
      const id = MODELS[_modelKey]?.id;
      if (id) _demotedFromNative.add(id);
      delete req.tools;
      delete req.tool_choice;
      resp = await _engine.chat.completions.create(req);
    } else if (/module has already been disposed|already (?:been )?(?:disposed|terminated)|context (?:is )?lost/i.test(msg)) {
      // WebGPU context lost or engine disposed (tab backgrounding, GPU
      // driver reset, OOM). Drop the dead handle and reload transparently.
      const key = _modelKey;
      _engine = null;
      _modelKey = null;
      emitProgress({ phase: 'download', text: 'Reloading on-device AI after GPU context loss…', progress: 0 });
      await loadModel(key);
      resp = await _engine.chat.completions.create(req);
    } else {
      throw e;
    }
  }
  const choice = resp.choices?.[0];
  const msg = choice?.message || {};
  return {
    content: msg.content || '',
    tool_calls: msg.tool_calls || null,
    finish_reason: choice?.finish_reason || '',
    usage: resp.usage || {}
  };
}

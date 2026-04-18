// ══════════════════════════════════════════════════════════════════════
// local-model.js — WebLLM wrapper
//
// Loads a quantized instruction model entirely in-browser via WebGPU.
// First load downloads ~1.5–2 GB from the MLC CDN; cached after that.
// Exposes a tiny chat-completion shim that mirrors the OpenAI-style
// {messages, tools} call the agent uses.
// ══════════════════════════════════════════════════════════════════════

const MODELS = {
  'qwen-3b':   { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',   label: 'Qwen 2.5 3B',   sizeGB: 1.9 },
  'llama-3b':  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B',  sizeGB: 1.8 },
  'qwen-1.5b': { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 1.5B', sizeGB: 1.0 },
  'llama-1b':  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B',  sizeGB: 0.8 }
};

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
const DEFAULT_KEY = 'qwen-3b';
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
  if (_loading) return _loading;
  if (!MODELS[key]) throw new Error(`Unknown model: ${key}`);
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
    setOptedIn(true);
    setPreferredModel(key);
    emitProgress({ phase: 'ready', text: `${MODELS[key].label} ready`, progress: 1 });
    return engine;
  })();

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
}

/**
 * Run a chat completion. messages is the OpenAI-style array.
 * If tools is provided, the model may emit tool calls.
 * Returns { content, tool_calls, usage }.
 */
export async function complete({ messages, tools, tool_choice = 'auto', temperature = 0.3, max_tokens = 512 }) {
  if (!_engine) throw new Error('Local model not loaded.');
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
    // Safety net: if the selected model rejects the tools field, demote it
    // for the rest of the session and retry without tools.
    const msg = e?.message || String(e);
    if (req.tools && /not supported for ChatCompletionRequest\.tools/i.test(msg)) {
      const id = MODELS[_modelKey]?.id;
      if (id) _demotedFromNative.add(id);
      delete req.tools;
      delete req.tool_choice;
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

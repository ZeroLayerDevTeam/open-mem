// The web viewer's LLM page: what the local LLM is doing (Ollama models in memory, GPU, queue, speed) and the few
// actions it offers (process the queue now, retry failed items, load or unload the model, pin a model, embed all).
import { loadSettings, saveSettings } from './config.mjs';
import { getMeta } from './db.mjs';
import { gpuReports, gpus } from './gpu.mjs';
import { resolveProvider, unloadOllama } from './llm.mjs';
import { callStats } from './llmstats.mjs';
import { drainerPid, spawnCli, spawnDrainer } from './queue.mjs';
import { countPending, embedEnabled } from './semantic.mjs';

export { parseNvidiaSmi, smiCandidates } from './gpu.mjs';

const OLLAMA_DEFAULT = 'http://127.0.0.1:11434';
const BUSY_FRESH_MS = 90000;
const isLocal = (settings) => ['auto', 'ollama'].includes(settings.provider || 'auto');
const ollamaUrl = (settings) => (settings.baseUrl || OLLAMA_DEFAULT).replace(/\/+$/, '');
const notEmbedding = (name) => !/embed|bge|nomic|minilm/i.test(name);

async function getJson(url, { timeoutMs = 2500, body } = {}) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from Ollama: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

const modelInfo = (m) => ({ name: m.name, size: m.size ?? null, params: m.details?.parameter_size ?? null,
  quant: m.details?.quantization_level ?? null, family: m.details?.family ?? null });

async function ollamaInfo(base) {
  try {
    const [version, ps, tags] = await Promise.all([getJson(`${base}/api/version`), getJson(`${base}/api/ps`), getJson(`${base}/api/tags`)]);
    return {
      up: true, url: base, version: version.version ?? null,
      loaded: (ps.models || []).map((m) => ({ ...modelInfo(m), vram: m.size_vram ?? null, context: m.context_length ?? null,
        expiresAt: Date.parse(m.expires_at) || null })),
      installed: (tags.models || []).map((m) => ({ ...modelInfo(m), modifiedAt: Date.parse(m.modified_at) || null, chat: notEmbedding(m.name) })),
    };
  } catch (err) {
    return { up: false, url: base, error: err.message };
  }
}

// Records still without a vector: counting them scans every table, so it waits until records or vectors change.
const embCache = new WeakMap();
function embeddings(db, settings) {
  if (!embedEnabled(settings)) return { enabled: false, model: settings.embedModel || null };
  const key = JSON.stringify(db.prepare(`SELECT (SELECT max(id) FROM observations) o, (SELECT max(id) FROM summaries) s,
    (SELECT max(id) FROM items) i, (SELECT count(*) FROM embeddings) e`).get());
  let hit = embCache.get(db);
  if (hit?.key !== key) { hit = { key, pending: countPending(db) }; embCache.set(db, hit); }
  return { enabled: true, model: settings.embedModel, done: db.prepare('SELECT count(*) n FROM embeddings WHERE model = ?').get(settings.embedModel).n, pending: hit.pending };
}

// Queue rows with what they are about: the tool and its file or command (payloads are redacted when queued).
function queueInfo(db) {
  const list = (where, order) => db.prepare(`SELECT id, kind, project, status, attempts, error, created_at,
      json_extract(payload, '$.tool') tool, json_extract(payload, '$.prompt_number') prompt_number,
      substr(COALESCE(json_extract(payload, '$.input.file_path'), json_extract(payload, '$.input.command'), json_extract(payload, '$.input.pattern'),
        json_extract(payload, '$.input.url'), json_extract(payload, '$.input.description'), ''), 1, 160) what
    FROM queue WHERE ${where} ORDER BY ${order} LIMIT 8`).all();
  return {
    counts: db.prepare('SELECT kind, status, count(*) n, min(created_at) oldest FROM queue GROUP BY kind, status').all(),
    next: list("status IN ('pending', 'processing')", 'id'),
    failed: list("status = 'failed'", 'id DESC'),
  };
}

export async function engineStatus(db, settings, { hours } = {}) {
  const local = isLocal(settings);
  const [provider, ollama, gpu] = await Promise.all([resolveProvider(settings), local ? ollamaInfo(ollamaUrl(settings)) : null, gpus()]);
  const busySeen = Number(getMeta(db, 'busy_seen_at') || 0);
  return {
    now: Date.now(),
    provider: {
      setting: settings.provider || 'auto', kind: provider.kind, model: provider.model || null, reason: provider.reason || null,
      pinned: settings.model || null, keepAlive: settings.llmKeepAlive || null, pauseWhenBusy: Boolean(settings.pauseWhenBusy),
      endpoint: provider.kind === 'openai' ? provider.baseUrl : null,
    },
    ollama,
    gpus: gpu.list, gpuError: gpu.error,
    // GPUs reported by the machines that run Ollama, for a server without one of its own.
    remoteGpus: gpuReports(db),
    busy: Date.now() - busySeen < BUSY_FRESH_MS ? getMeta(db, 'busy_reason') : null,
    drainer: drainerPid(),
    // An LLM that answered before and is down now: the queue waits for it instead of storing records raw.
    waitingForLlm: provider.kind === 'none' && Boolean(provider.unreachable) && Boolean(getMeta(db, 'llm_seen_at')),
    queue: queueInfo(db),
    embeddings: embeddings(db, settings),
    stats: callStats(db, { hours }),
  };
}

export const ENGINE_ACTIONS = ['drain', 'retry', 'unload', 'load', 'model', 'embed'];

export async function engineAction(db, settings, action, body = {}) {
  const base = ollamaUrl(settings);
  const needLocal = () => { if (!isLocal(settings)) throw new Error('only for a local Ollama (provider auto or ollama)'); };
  if (action === 'drain') return { started: spawnDrainer(body.force ? ['--force'] : []), pid: drainerPid() };
  if (action === 'retry') {
    const retried = Number(db.prepare("UPDATE queue SET status = 'pending', attempts = 0, error = NULL WHERE status = 'failed'").run().changes);
    return { retried, started: retried ? spawnDrainer() : false };
  }
  if (action === 'unload') { needLocal(); return { unloaded: await unloadOllama(base) }; }
  if (action === 'load') {
    needLocal();
    const model = body.model || (await resolveProvider(settings)).model;
    if (!model) throw new Error('no chat model installed in Ollama');
    if (!notEmbedding(model)) throw new Error(`${model} is an embedding model`);
    const started = Date.now();
    await getJson(`${base}/api/generate`, { timeoutMs: 300000, body: { model, keep_alive: '10m' } });
    return { loaded: model, ms: Date.now() - started };
  }
  if (action === 'model') {
    needLocal();
    const name = String(body.model || '').trim();
    if (name) {
      const info = await ollamaInfo(base);
      if (!info.up) throw new Error('Ollama is not reachable');
      if (!info.installed.some((m) => m.name === name && m.chat)) throw new Error(`${name} is not an installed chat model`);
    }
    saveSettings({ ...loadSettings(), model: name });
    settings.model = name; // the running server too; drainers read settings.json
    return { model: name || null };
  }
  if (action === 'embed') {
    if (!embedEnabled(settings)) throw new Error('semantic search is off (embedModel empty or provider not local)');
    spawnCli('embed', '--all');
    return { started: true };
  }
  throw new Error(`unknown action: ${action}`);
}

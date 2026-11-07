// GPU budget: whether open-mem may use the local Ollama right now, and with which model. Other jobs share the GPU
// (games, model training, other apps' Ollama models): open-mem only takes the video memory left over, never pushes
// another app's model out of Ollama, and steps aside while a job says so through a marker file or the user pauses it.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPath } from './config.mjs';
import { gpus } from './gpu.mjs';
import { ownModels, sameModel } from './llm.mjs';

const MIB = 1024 * 1024;
// A model in VRAM takes about its file size plus the KV cache of an 8k context; measured on gemma3 12b/4b (q8_0 cache).
const LOAD_FACTOR = 1.1;
const MARKER_MAX_BYTES = 64 * 1024;

const expandHome = (p) => String(p).replace(/^~(?=$|[\\/])/, os.homedir());
const pauseFile = () => dataPath('pause.json');

// --- manual pause (`cli pause` / `cli resume`) ------------------------------------------------------------------------
export function setPause({ reason = '', hours = 0, now = Date.now() } = {}) {
  const pause = { reason: String(reason).slice(0, 200), at: now, until: hours > 0 ? now + hours * 3600000 : null };
  fs.writeFileSync(pauseFile(), JSON.stringify(pause, null, 2) + '\n');
  return pause;
}

export function clearPause() {
  const had = fs.existsSync(pauseFile());
  fs.rmSync(pauseFile(), { force: true });
  return had;
}

// The pause set by hand, or null (an expired one is removed).
export function manualPause(now = Date.now()) {
  let pause;
  try { pause = JSON.parse(fs.readFileSync(pauseFile(), 'utf8')); } catch { return null; }
  if (pause?.until && now > pause.until) { clearPause(); return null; }
  return { kind: 'manual', detail: pause?.reason || '', until: pause?.until || null };
}

// --- marker files -----------------------------------------------------------------------------------------------------
function readMarker(file, now) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  let info = {};
  if (st.size <= MARKER_MAX_BYTES) {
    try { info = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* plain marker: its existence is enough */ }
  }
  const staleMs = Number(info.stale_after_s) * 1000;
  if (staleMs > 0 && now - Math.max(st.mtimeMs, Date.parse(info.heartbeat) || 0) > staleMs) return null; // its job died
  const what = [info.owner, info.phase].filter((x) => typeof x === 'string' && x).join(' ').slice(0, 80);
  return { kind: 'marker', detail: what || path.basename(file), file };
}

// First live marker among settings.busyFiles (files, or folders whose files are markers), or null.
export function markerPause(settings, now = Date.now()) {
  for (const entry of settings.busyFiles || []) {
    const p = expandHome(entry);
    let files = [p];
    try { if (fs.statSync(p).isDirectory()) files = fs.readdirSync(p).sort().map((f) => path.join(p, f)); } catch { continue; }
    for (const file of files) {
      const hit = readMarker(file, now);
      if (hit) return hit;
    }
  }
  return null;
}

// --- Ollama limits ----------------------------------------------------------------------------------------------------
// The server reads OLLAMA_GPU_OVERHEAD and OLLAMA_MAX_LOADED_MODELS from the user's environment. A process started
// before they were set does not see them, so on Windows the user's registry environment is read as well.
function regValue(name) {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Environment', '/v', name], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : (String(stdout).match(new RegExp(`${name}\\s+REG_\\w+\\s+(\\S+)`)) || [])[1] || null);
    });
  });
}

let limitsCache = null;
export async function ollamaLimits({ env = process.env, platform = process.platform, gpuCount = 1 } = {}) {
  if (limitsCache) return limitsCache;
  const read = async (name) => env[name] ?? (platform === 'win32' ? await regValue(name) : null);
  const overhead = Number(await read('OLLAMA_GPU_OVERHEAD')) || 0;
  const maxLoaded = Number(await read('OLLAMA_MAX_LOADED_MODELS')) || 3 * Math.max(1, gpuCount); // Ollama's default
  limitsCache = { overheadMb: Math.round(overhead / MIB), maxLoaded };
  return limitsCache;
}

async function ollamaGet(baseUrl, route) {
  const res = await fetch(`${baseUrl}${route}`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${baseUrl}${route}`);
  return res.json();
}

// --- the plan ---------------------------------------------------------------------------------------------------------
// Which chat model to use now, or why to wait. `embed`: the embedding model is needed too. `backlog`: queue length.
// `exact`: only `model` itself, no fallback (the GPU guard serves what the server asked for).
// Returns { model, unload } (own models loaded that the plan does not use: unload them first) or { pause }.
// deps (tests): ps(), tags(), gpus(), limits().
export async function planGpu(settings, { baseUrl, model, embed = false, backlog = 0, exact = false }, deps = {}) {
  const {
    ps = () => ollamaGet(baseUrl, '/api/ps'), tags = () => ollamaGet(baseUrl, '/api/tags'),
    gpus: readGpus = gpus, limits = ollamaLimits,
  } = deps;
  let loaded;
  let installed;
  try {
    [loaded, installed] = await Promise.all([ps(), tags()]).then(([p, t]) => [p.models || [], t.models || []]);
  } catch {
    return { model, unload: [] }; // Ollama just answered resolveProvider: let the call itself report what is wrong
  }
  const own = ownModels(settings, model);
  const isOwn = (name) => own.some((o) => sameModel(o, name));
  const foreign = loaded.filter((m) => !isOwn(m.name));
  const loadedOwn = (name) => loaded.find((m) => sameModel(m.name, name));
  const size = (name) => installed.find((m) => sameModel(m.name, name))?.size;
  const fallbacks = exact ? [] : (settings.fallbackModels || []).filter((n) => size(n) && !sameModel(n, model));
  // A lighter model while other apps use Ollama (they share the GPU's compute too) or while a backlog waits.
  const candidates = fallbacks.length && (foreign.length || backlog > settings.backlogItems) ? fallbacks : [model, ...fallbacks];

  const gpu = settings.gpuBudget ? await readGpus() : { list: null };
  const list = (gpu.list || []).filter((g) => g.memTotalMb != null && g.memUsedMb != null);
  const lim = await limits({ gpuCount: list.length || 1 });
  const vramOf = (name) => {
    const m = loadedOwn(name);
    return m ? (m.size_vram ?? m.size ?? 0) / MIB : ((size(name) || 0) / MIB) * LOAD_FACTOR;
  };
  const embedName = embed ? settings.embedModel : null;
  const embedMb = embedName ? vramOf(embedName) : 0;
  let freeMb = Infinity;
  if (list.length) {
    // open-mem's own loaded models count as free: they are unloaded when the plan does not use them. Not with `exact`:
    // the guard leaves the local drain's models alone, so only a model already loaded costs nothing more.
    const ownLoadedMb = exact ? 0 : loaded.filter((m) => isOwn(m.name)).reduce((n, m) => n + (m.size_vram ?? 0) / MIB, 0);
    freeMb = list.reduce((n, g) => n + g.memTotalMb - g.memUsedMb, 0) + ownLoadedMb - lim.overheadMb - settings.gpuReserveMb;
  }
  const chosen = exact && loadedOwn(model) ? model : candidates.find((name) => vramOf(name) + embedMb <= freeMb);
  if (!chosen) {
    const need = Math.round(vramOf(candidates[0]) + embedMb);
    return { pause: { kind: 'gpu', detail: `${Math.max(0, Math.round(freeMb))} MiB free, ${candidates[0]} needs ${need} MiB` } };
  }
  const extraSlots = (loadedOwn(chosen) ? 0 : 1) + (embedName && !loadedOwn(embedName) ? 1 : 0);
  if (foreign.length && foreign.length + extraSlots > lim.maxLoaded) {
    return { pause: { kind: 'slots', detail: `${foreign.map((m) => m.name).join(', ')} (OLLAMA_MAX_LOADED_MODELS=${lim.maxLoaded})` } };
  }
  const keep = [chosen, embedName].filter(Boolean);
  return { model: chosen, unload: exact ? [] : loaded.filter((m) => isOwn(m.name) && !keep.some((k) => sameModel(k, m.name))).map((m) => m.name) };
}

// For tests: forget the cached Ollama limits.
export const resetLimits = () => { limitsCache = null; };

// GPU guard: the only door a shared server has to this machine's Ollama. The server has no GPU and cannot see what runs
// here, so its LLM work (embeddings, notes review, search queries) comes through this small proxy. While a game runs, a
// marker file says another job holds the GPU, or the queue is paused by hand, the door is closed (503), work in flight is
// cut and open-mem's models leave the GPU (never another app's). A call whose model does not fit in the free video
// memory is refused the same way. Ollama itself stays on loopback, and with the guard down the server simply has no LLM:
// a failure here never costs the game the GPU.
import http from 'node:http';
import path from 'node:path';
import { manualPause, markerPause, planGpu } from './budget.mjs';
import { busyReason } from './busy.mjs';
import { log } from './config.mjs';
import { ownModels, unloadOllama } from './llm.mjs';

const OLLAMA_DEFAULT = 'http://127.0.0.1:11434';
// What a server needs from Ollama. No pull, delete or create.
const ROUTES = new Set(['GET /api/tags', 'GET /api/ps', 'GET /api/version', 'POST /api/chat', 'POST /api/embed', 'POST /api/generate']);
const ACTIVE_MS = 60000; // listing processes costs half a second: only look while the server is using the GPU
const MAX_BODY = 32 * 1024 * 1024;
const PLAN_REUSE_MS = 5000;

const reply = (res, status, error) => {
  if (res.destroyed || res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

// A process path shows as its file name; other reasons as they are.
const label = (reason) => (/^([a-z]:)?[\\/]/i.test(reason) ? path.basename(reason.replace(/\\/g, '/')) : reason);

// deps: busy(settings) -> reason|null, unload(baseUrl, models) -> names, reload() -> current settings,
//   paused(settings) -> { kind, detail }|null (manual pause, marker files), plan(settings, opts) -> { model }|{ pause }.
export function createGuard(settings, { busy = busyReason, unload = unloadOllama, reload = () => settings,
  paused = (s) => manualPause() ?? markerPause(s), plan = planGpu } = {}) {
  const upstream = new URL(settings.baseUrl || OLLAMA_DEFAULT);
  const allowed = new Set(settings.guardAllow);
  const pollMs = settings.guardPollSeconds * 1000;
  const flights = new Set();
  const served = new Set(); // models the server asked for: open-mem's, the only ones the guard frees besides its own
  const plans = new Map();
  let reason = null;
  let checkedAt = 0;
  let lastRequest = 0;
  let checking = null;

  async function freeGpu() {
    try {
      const names = await unload(settings.baseUrl, ownModels(reload(), ...served));
      if (names.length) log('info', `gpu guard unloaded ${names.join(', ')}`);
    } catch { /* Ollama not running: nothing holds the GPU */ }
  }

  async function look() {
    const was = reason;
    const s = reload();
    const pause = paused(s);
    reason = pause ? (pause.kind === 'manual' ? `paused by hand${pause.detail ? `: ${pause.detail}` : ''}` : pause.detail) : await busy(s);
    checkedAt = Date.now();
    if (reason) {
      if (was !== reason) log('info', `gpu guard closed, ${flights.size} call(s) cut: ${reason}`);
      for (const cut of flights) cut();
      await freeGpu(); // also while it stays closed: a local drain may have loaded a model meanwhile
    } else if (was) log('info', 'gpu guard open again');
    return reason;
  }
  const check = () => (checking ??= look().finally(() => { checking = null; }));

  // Whether the model of a call fits in the GPU now (decisions are reused for a few seconds: search sends bursts).
  async function fits(model) {
    const hit = plans.get(model);
    if (hit && Date.now() - hit.at < PLAN_REUSE_MS) return hit.pause;
    const { pause = null } = await plan(reload(), { baseUrl: settings.baseUrl, model, exact: true });
    plans.set(model, { at: Date.now(), pause });
    return pause;
  }

  function forward(req, res, body) {
    const up = http.request({ hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url,
      headers: { ...req.headers, host: upstream.host, ...(body ? { 'content-length': body.length } : {}) } },
    (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    const cut = () => { up.destroy(); res.destroy(); };
    flights.add(cut);
    res.on('close', () => { flights.delete(cut); up.destroy(); });
    up.on('error', (err) => reply(res, 502, `Ollama: ${err.message}`));
    up.end(body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const from = String(req.socket.remoteAddress).replace(/^::ffff:/, '');
      if (!allowed.has(from)) {
        log('warn', `gpu guard refused ${from}`);
        return reply(res, 403, 'address not allowed');
      }
      lastRequest = Date.now();
      if (!ROUTES.has(`${req.method} ${req.url.split('?')[0]}`)) return reply(res, 404, 'route not allowed');
      // A marker or a manual pause closes the door at once (a stat per request), not only at the next poll.
      const closed = await (Date.now() - checkedAt >= pollMs || (!reason && paused(reload())) ? check() : checking ?? reason);
      if (closed) return reply(res, 503, `GPU busy: ${label(closed)}`);
      const body = req.method === 'POST' ? await readBody(req) : null;
      let json = null;
      try { json = body?.length ? JSON.parse(body) : null; } catch { /* Ollama answers bad JSON itself */ }
      const model = typeof json?.model === 'string' ? json.model : null;
      // keep_alive 0 without input only unloads: it needs no memory.
      const unloading = json?.keep_alive === 0 && !json.messages && !json.prompt && !json.input;
      if (model && !unloading) {
        served.add(model);
        const pause = await fits(model);
        if (pause) return reply(res, 503, `GPU busy: ${pause.detail}`);
      }
      forward(req, res, body);
    } catch (err) {
      reply(res, 500, err.message);
    }
  });
  const timer = setInterval(() => {
    if (flights.size || Date.now() - lastRequest < ACTIVE_MS) check().catch((err) => log('warn', `gpu guard check failed: ${err.message}`));
  }, pollMs);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return server;
}

export function startGuard(settings, deps) {
  return new Promise((resolve, reject) => {
    const server = createGuard(settings, deps);
    server.once('error', reject);
    server.listen(settings.guardPort, '0.0.0.0', () => resolve(server));
  });
}

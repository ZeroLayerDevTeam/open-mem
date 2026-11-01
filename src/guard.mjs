// GPU guard: the only door a shared server has to this machine's Ollama. The server has no GPU and cannot see what runs
// here, so its LLM work (embeddings, notes review, search queries) comes through this small proxy. While a game runs the
// door is closed (503), work in flight is cut and the models leave the GPU. Ollama itself stays on loopback, and with the
// guard down the server simply has no LLM: a failure here never costs the game the GPU.
import http from 'node:http';
import path from 'node:path';
import { busyReason } from './busy.mjs';
import { log } from './config.mjs';
import { unloadOllama } from './llm.mjs';

const OLLAMA_DEFAULT = 'http://127.0.0.1:11434';
// What a server needs from Ollama. No pull, delete or create.
const ROUTES = new Set(['GET /api/tags', 'GET /api/ps', 'GET /api/version', 'POST /api/chat', 'POST /api/embed', 'POST /api/generate']);
const ACTIVE_MS = 60000; // listing processes costs half a second: only look while the server is using the GPU

const reply = (res, status, error) => {
  if (res.destroyed || res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
};

// deps: busy(settings) -> reason|null, unload(baseUrl) -> names, reload() -> current settings.
export function createGuard(settings, { busy = busyReason, unload = unloadOllama, reload = () => settings } = {}) {
  const upstream = new URL(settings.baseUrl || OLLAMA_DEFAULT);
  const allowed = new Set(settings.guardAllow);
  const pollMs = settings.guardPollSeconds * 1000;
  const flights = new Set();
  let reason = null;
  let checkedAt = 0;
  let lastRequest = 0;
  let checking = null;

  async function freeGpu() {
    try {
      const names = await unload(settings.baseUrl);
      if (names.length) log('info', `gpu guard unloaded ${names.join(', ')}`);
    } catch { /* Ollama not running: nothing holds the GPU */ }
  }

  async function look() {
    const was = reason;
    reason = await busy(reload());
    checkedAt = Date.now();
    if (reason) {
      if (!was) log('info', `gpu guard closed, ${flights.size} call(s) cut: ${reason}`);
      for (const cut of flights) cut();
      await freeGpu(); // also while it stays closed: a local drain may have loaded a model meanwhile
    } else if (was) log('info', 'gpu guard open again');
    return reason;
  }
  const check = () => (checking ??= look().finally(() => { checking = null; }));

  function forward(req, res) {
    const up = http.request({ hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url,
      headers: { ...req.headers, host: upstream.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    const cut = () => { up.destroy(); res.destroy(); };
    flights.add(cut);
    res.on('close', () => { flights.delete(cut); up.destroy(); });
    up.on('error', (err) => reply(res, 502, `Ollama: ${err.message}`));
    req.pipe(up);
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
      const closed = await (Date.now() - checkedAt >= pollMs ? check() : checking ?? reason);
      if (closed) return reply(res, 503, `GPU busy: ${path.basename(closed.replace(/\\/g, '/'))}`);
      forward(req, res);
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

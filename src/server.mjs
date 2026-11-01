// HTTP server: web viewer + JSON API. Web users log in with the admin token (cookie session);
// devices in shared mode authenticate with their device key (Bearer).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAdminToken, checkWebSession, createWebSession, deleteWebSession, deviceForKey, hasAdminToken } from './auth.mjs';
import { log, VERSION } from './config.mjs';
import { local } from './backend.mjs';
import { deleteItem, TASK_STATUSES } from './items.mjs';
import { exportFileName, itemsMarkdown } from './export.mjs';
import { ingest } from './sync.mjs';
import { gzipSync } from 'node:zlib';
import { ENGINE_ACTIONS, engineAction, engineStatus } from './engine.mjs';
import { storeGpuReport } from './gpu.mjs';
import { facets, feed, find, itemsPage, overview, projectDetail, projects, record, sessionDetail, sessions } from './views.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/ui.js': ['ui.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const COOKIE = 'om_session';
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Bodies over 1 KB are gzipped when the client accepts it (pages of 50 records shrink about 5x).
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  let data = isJson ? JSON.stringify(body) : body;
  const zip = data.length > 1024 && /\bgzip\b/.test(String(res.req?.headers['accept-encoding'] || ''));
  if (zip) data = gzipSync(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS, ...(isJson ? { 'content-type': 'application/json; charset=utf-8' } : {}), ...headers,
    ...(zip ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}),
  });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// --- login rate limit: 10 attempts per IP per 15 minutes -------------------------------
const attempts = new Map();
const PRIVATE_IP = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$|^f[cd]/i;

// Behind a reverse proxy every request comes from the proxy's private address; then the client is in
// X-Real-IP / X-Forwarded-For. A public peer cannot set those headers to dodge the limit.
export function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  if (!PRIVATE_IP.test(peer)) return peer;
  const fwd = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || peer;
}

function allowLogin(ip) {
  const now = Date.now();
  if (attempts.size > 10000) for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
  const a = attempts.get(ip);
  if (!a || a.reset < now) { attempts.set(ip, { n: 1, reset: now + 15 * 60 * 1000 }); return true; }
  a.n++;
  return a.n <= 10;
}

function identify(db, req) {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) {
    const device = deviceForKey(db, auth.slice(7).trim());
    return device ? { kind: 'device', device } : null;
  }
  const sid = cookies(req)[COOKIE];
  return sid && checkWebSession(db, sid) ? { kind: 'admin', device: 'web' } : null;
}

// Cookie-authenticated writes must come from our own page (SameSite=Strict already blocks most CSRF).
function checkOrigin(req) {
  const origin = req.headers.origin;
  let host = null;
  try { host = origin ? new URL(origin).host : req.headers.host; } catch { /* "null" or garbage */ }
  if (host !== req.headers.host) throw new HttpError(403, 'cross-origin request refused');
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'JSON body required');
}

const num = (v, d) => (v == null || v === '' ? d : Number(v));
const pageOf = (q) => ({ page: num(q.get('page')), pageSize: num(q.get('size')) });

export function createServer(db, settings) {
  const getRoutes = {
    '/api/overview': () => overview(db, settings),
    '/api/projects': () => projects(db),
    '/api/project': (q) => projectDetail(db, q.get('name')) ?? (() => { throw new HttpError(404, 'unknown project'); })(),
    '/api/facets': () => facets(db),
    '/api/engine': (q) => engineStatus(db, settings, { hours: num(q.get('hours'), 24) }),
    '/api/feed': (q) => feed(db, { project: q.get('project'), kinds: q.get('kinds') || undefined, device: q.get('device'), before: num(q.get('before')), ...pageOf(q) }),
    '/api/sessions': (q) => sessions(db, { project: q.get('project'), device: q.get('device'), q: q.get('q'), ...pageOf(q) }),
    '/api/items': (q) => itemsPage(db, { kind: q.get('kind'), project: q.get('project'), status: q.get('status'), q: q.get('q'), ...pageOf(q) }),
    '/api/find': (q) => find(db, {
      query: q.get('q'), project: q.get('project'), kind: q.get('kind') || 'all', type: q.get('type'), dateStart: q.get('from'), dateEnd: q.get('to'), ...pageOf(q),
    }, settings),
    '/api/session': (q) => sessionDetail(db, q.get('id')) ?? (() => { throw new HttpError(404, 'unknown session'); })(),
    '/api/record': (q) => record(db, q.get('ref')) ?? (() => { throw new HttpError(404, 'unknown record'); })(),
    '/api/meta': () => ({ version: VERSION, taskStatuses: TASK_STATUSES }),
  };
  const opRoutes = {
    '/api/search': 'search', '/api/timeline': 'timeline', '/api/get': 'get', '/api/context': 'context', '/api/recall': 'recall',
    '/api/items/list': 'itemsList', '/api/items/add': 'itemAdd', '/api/items/update': 'itemUpdate',
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const route = url.pathname;
    if (req.method === 'GET' && STATIC[route]) {
      const [file, type] = STATIC[route];
      return send(res, 200, fs.readFileSync(path.join(WEB, file)), { 'content-type': type });
    }
    if (route === '/api/health') return send(res, 200, { ok: true, version: VERSION });

    if (route === '/api/login' && req.method === 'POST') {
      checkOrigin(req);
      const ip = clientIp(req);
      if (!allowLogin(ip)) throw new HttpError(429, 'too many attempts, wait 15 minutes');
      if (!hasAdminToken(db)) throw new HttpError(503, 'no admin token yet: run `cli token init` on the server');
      const { token } = await readBody(req, 4096);
      if (!checkAdminToken(db, String(token || '').trim())) {
        log('warn', `web login failed from ${ip}`);
        throw new HttpError(401, 'wrong token');
      }
      attempts.delete(ip);
      const s = createWebSession(db);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${s.maxAgeSec}${secure}` });
    }
    if (route === '/api/logout' && req.method === 'POST') {
      deleteWebSession(db, cookies(req)[COOKIE]);
      return send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }

    const who = identify(db, req);
    if (route === '/api/me') return send(res, 200, { authenticated: Boolean(who), kind: who?.kind ?? null, setup: hasAdminToken(db) });
    if (!who) throw new HttpError(401, 'login required');

    if (req.method === 'GET' && route === '/api/export') {
      const project = url.searchParams.get('project') || null;
      const items = local.itemsList(db, { project: project || undefined, limit: 500 })
        .filter((i) => (project ? true : !i.project));
      return send(res, 200, itemsMarkdown(project, items), {
        'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${exportFileName(project)}"`,
      });
    }
    if (req.method === 'GET' && getRoutes[route]) return send(res, 200, await getRoutes[route](url.searchParams));
    if (req.method !== 'POST') throw new HttpError(404, 'not found');
    if (who.kind === 'admin') checkOrigin(req);

    if (route === '/api/ingest') {
      if (who.kind !== 'device') throw new HttpError(403, 'devices only');
      return send(res, 200, { ok: true, counts: ingest(db, who.device, await readBody(req, 64 * 1024 * 1024)) });
    }
    if (route === '/api/gpu') {
      if (who.kind !== 'device') throw new HttpError(403, 'devices only');
      try {
        return send(res, 200, { ok: true, gpus: storeGpuReport(db, who.device, await readBody(req, 16 * 1024)) });
      } catch (err) {
        throw err instanceof HttpError ? err : new HttpError(400, err.message);
      }
    }
    if (route.startsWith('/api/engine/')) {
      if (who.kind !== 'admin') throw new HttpError(403, 'admin only');
      const action = route.slice('/api/engine/'.length);
      if (!ENGINE_ACTIONS.includes(action)) throw new HttpError(404, 'not found');
      const body = await readBody(req, 4096);
      try {
        return send(res, 200, { result: await engineAction(db, settings, action, body) });
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    }
    if (route === '/api/items/delete') {
      if (who.kind !== 'admin') throw new HttpError(403, 'admin only');
      const { id } = await readBody(req, 4096);
      return send(res, 200, { result: deleteItem(db, id) });
    }
    const op = opRoutes[route];
    if (!op) throw new HttpError(404, 'not found');
    const body = await readBody(req, 1024 * 1024);
    if (op === 'itemAdd' || op === 'itemUpdate') body.device = who.kind === 'device' ? who.device : 'web';
    try {
      return send(res, 200, { result: await local[op](db, body, settings) });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, err.message); // validation errors from items/store
    }
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status || 500;
      if (status >= 500) log('error', `server ${req.method} ${req.url}: ${err.stack || err.message}`);
      if (!res.headersSent) send(res, status, { error: status >= 500 ? 'internal error' : err.message });
      else res.end();
    });
  });
}

export function serve(db, settings, { host = settings.webHost, port = settings.webPort } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer(db, settings);
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

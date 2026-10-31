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
import { ingest } from './sync.mjs';
import { feed, overview, projectDetail, projects, record, sessionDetail, sessions } from './views.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
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

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY_HEADERS, ...(isJson ? { 'content-type': 'application/json; charset=utf-8' } : {}), ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
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
function allowLogin(ip) {
  const now = Date.now();
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

export function createServer(db, settings) {
  const getRoutes = {
    '/api/overview': () => overview(db, settings),
    '/api/projects': () => projects(db),
    '/api/project': (q) => projectDetail(db, q.get('name')) ?? (() => { throw new HttpError(404, 'unknown project'); })(),
    '/api/feed': (q) => feed(db, { project: q.get('project'), kinds: q.get('kinds') || undefined, device: q.get('device'), before: num(q.get('before')), limit: num(q.get('limit'), 60) }),
    '/api/sessions': (q) => sessions(db, { project: q.get('project'), before: num(q.get('before')), limit: num(q.get('limit'), 40) }),
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
      if (!allowLogin(req.socket.remoteAddress)) throw new HttpError(429, 'too many attempts, wait 15 minutes');
      if (!hasAdminToken(db)) throw new HttpError(503, 'no admin token yet: run `cli token init` on the server');
      const { token } = await readBody(req, 4096);
      if (!checkAdminToken(db, String(token || '').trim())) {
        log('warn', `web login failed from ${req.socket.remoteAddress}`);
        throw new HttpError(401, 'wrong token');
      }
      attempts.delete(req.socket.remoteAddress);
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

    if (req.method === 'GET' && getRoutes[route]) return send(res, 200, getRoutes[route](url.searchParams));
    if (req.method !== 'POST') throw new HttpError(404, 'not found');
    if (who.kind === 'admin') checkOrigin(req);

    if (route === '/api/ingest') {
      if (who.kind !== 'device') throw new HttpError(403, 'devices only');
      return send(res, 200, { ok: true, counts: ingest(db, who.device, await readBody(req, 64 * 1024 * 1024)) });
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
      return send(res, 200, { result: local[op](db, body, settings) });
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

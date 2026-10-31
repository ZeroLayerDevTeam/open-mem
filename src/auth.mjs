// Admin token, device keys and web sessions. Only SHA-256 hashes are stored: every secret
// is 32 random bytes, so a fast hash is enough and plaintext never touches the database.
import crypto from 'node:crypto';
import { getMeta, setMeta } from './db.mjs';

const ADMIN_PREFIX = 'om_admin_';
const DEVICE_PREFIX = 'om_dev_';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const random = (prefix) => `${prefix}${crypto.randomBytes(32).toString('base64url')}`;

function safeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function hasAdminToken(db) {
  return Boolean(getMeta(db, 'admin_token_hash'));
}

// Returns the new plaintext token exactly once, or null if one already exists (unless reset).
export function createAdminToken(db, { reset = false } = {}) {
  if (hasAdminToken(db) && !reset) return null;
  const token = random(ADMIN_PREFIX);
  setMeta(db, 'admin_token_hash', sha256(token));
  setMeta(db, 'admin_token_created_at', new Date().toISOString());
  if (reset) db.prepare('DELETE FROM web_sessions').run(); // log out everyone
  return token;
}

export function checkAdminToken(db, token) {
  return typeof token === 'string' && token.startsWith(ADMIN_PREFIX) && safeEqualHex(sha256(token), getMeta(db, 'admin_token_hash'));
}

export function addDevice(db, name) {
  const clean = String(name || '').trim();
  if (!/^[\w.-]{1,64}$/.test(clean)) throw new Error('Device name: 1-64 letters, digits, dot, dash or underscore');
  const key = random(DEVICE_PREFIX);
  db.prepare(`INSERT INTO devices (name, key_hash, created_at) VALUES (?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at`)
    .run(clean, sha256(key), Date.now());
  return key;
}

export function removeDevice(db, name) {
  return Number(db.prepare('DELETE FROM devices WHERE name = ?').run(name).changes) > 0;
}

export function listDevices(db) {
  return db.prepare('SELECT name, created_at, last_seen_at FROM devices ORDER BY name').all();
}

export function deviceForKey(db, key) {
  if (typeof key !== 'string' || !key.startsWith(DEVICE_PREFIX)) return null;
  const row = db.prepare('SELECT id, name FROM devices WHERE key_hash = ?').get(sha256(key));
  if (row) db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id);
  return row?.name ?? null;
}

export function createWebSession(db) {
  const id = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('DELETE FROM web_sessions WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO web_sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)').run(sha256(id), now, now + SESSION_TTL_MS);
  return { id, maxAgeSec: SESSION_TTL_MS / 1000 };
}

export function checkWebSession(db, id) {
  if (!id) return false;
  return Boolean(db.prepare('SELECT 1 FROM web_sessions WHERE id_hash = ? AND expires_at > ?').get(sha256(id), Date.now()));
}

export function deleteWebSession(db, id) {
  if (id) db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(sha256(id));
}

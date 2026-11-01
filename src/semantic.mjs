// Semantic search: Ollama embeddings of every record, merged with the full-text search by reciprocal rank fusion.
// Vectors are cut to DIM dimensions and normalized (embeddinggemma is trained for that), so a dot product is the
// cosine and the whole database fits in memory. Without an Ollama with the embedding model, search stays full-text.
import { getMeta } from './db.mjs';
import { clip, normalizeSearch, refId, search } from './store.mjs';

export const DIM = 256;
const QUERY_TIMEOUT_MS = 3000;
const RRF_K = 60;
const POOL = 60;
const MAX_POOL = 100; // search() returns at most 100 rows per call

const baseUrl = (settings) => (settings.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
// Embeddings need Ollama: a local one in auto/ollama mode, never an OpenAI-compatible endpoint.
export const embedEnabled = (settings) => Boolean(settings.embedModel) && ['auto', 'ollama'].includes(settings.provider || 'auto');

export function toVector(values) {
  const v = Float32Array.from(values.slice(0, DIM));
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export async function embed(settings, texts, timeoutMs = 120000) {
  const res = await fetch(`${baseUrl(settings)}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: settings.embedModel, input: texts, keep_alive: settings.llmKeepAlive || undefined, truncate: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from Ollama embed: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text).embeddings.map(toVector);
}

// --- what gets embedded -------------------------------------------------------------------------
const TEXT_SQL = {
  obs: `SELECT o.id, 'obs' kind, o.project, o.type || ': ' || COALESCE(o.title, '') || '. ' || COALESCE(o.subtitle, '') || ' ' || COALESCE(o.narrative, '') text
    FROM observations o WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.ref = CAST(o.id AS TEXT)) ORDER BY o.id DESC LIMIT ?`,
  sum: `SELECT s.id, 'sum' kind, s.project, 'summary: ' || COALESCE(s.request, '') || '. ' || COALESCE(s.completed, '') || ' ' || COALESCE(s.learned, '') text
    FROM summaries s WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.ref = 'S' || s.id) ORDER BY s.id DESC LIMIT ?`,
  item: `SELECT i.id, 'item' kind, i.project, i.kind || ': ' || i.title || '. ' || COALESCE(i.body, '') text
    FROM items i WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.ref = 'I' || i.id) ORDER BY i.id DESC LIMIT ?`,
};

export function pendingEmbeddings(db, limit) {
  const rows = [];
  for (const kind of ['item', 'sum', 'obs']) {
    if (rows.length >= limit) break;
    rows.push(...db.prepare(TEXT_SQL[kind]).all(limit - rows.length));
  }
  return rows;
}

export const countPending = (db) => db.prepare(`SELECT
    (SELECT count(*) FROM observations o WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.ref = CAST(o.id AS TEXT)))
  + (SELECT count(*) FROM summaries s WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.ref = 'S' || s.id))
  + (SELECT count(*) FROM items i WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.ref = 'I' || i.id)) n`).get().n;

// Embeds up to `max` records without a vector, newest first, in batches. `stop()` is checked between batches
// (a game started). Returns how many were embedded.
export async function embedPending(db, settings, { max = 2000, batch = 32, stop = async () => false } = {}) {
  if (!embedEnabled(settings)) return 0;
  // Vectors of another model cannot be compared: a model change starts over.
  db.prepare('DELETE FROM embeddings WHERE model != ?').run(settings.embedModel);
  const insert = db.prepare('INSERT OR REPLACE INTO embeddings (ref, model, vec, created_at) VALUES (?, ?, ?, ?)');
  let done = 0;
  while (done < max) {
    const rows = pendingEmbeddings(db, Math.min(batch, max - done));
    if (!rows.length) break;
    const vecs = await embed(settings, rows.map((r) => clip(r.text, 2000)));
    db.exec('BEGIN IMMEDIATE');
    try {
      rows.forEach((r, i) => insert.run(refId(r), settings.embedModel, Buffer.from(vecs[i].buffer), Date.now()));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    done += rows.length;
    if (await stop()) break;
  }
  return done;
}

// --- vector cache ---------------------------------------------------------------------------------
// Loaded once per process and topped up by rowid; a long-running server keeps it warm.
const cache = { db: null, model: null, maxRowid: 0, refs: [], vecs: [] };

function vectors(db, model) {
  if (cache.db !== db || cache.model !== model) Object.assign(cache, { db, model, maxRowid: 0, refs: [], vecs: [] });
  const rows = db.prepare('SELECT rowid, ref, vec FROM embeddings WHERE rowid > ? AND model = ? ORDER BY rowid').all(cache.maxRowid, model);
  for (const r of rows) {
    cache.refs.push(r.ref);
    const b = r.vec;
    cache.vecs.push(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
    cache.maxRowid = r.rowid;
  }
  return cache;
}

function nearest(db, model, q, kinds, n) {
  const { refs, vecs } = vectors(db, model);
  const prefix = (ref) => (ref[0] === 'S' ? 'sum' : ref[0] === 'I' ? 'item' : 'obs');
  const top = [];
  for (let i = 0; i < vecs.length; i++) {
    if (!kinds.has(prefix(refs[i]))) continue;
    const v = vecs[i];
    let s = 0;
    for (let j = 0; j < v.length; j++) s += v[j] * q[j];
    if (top.length < n) { top.push([s, refs[i]]); if (top.length === n) top.sort((a, b) => a[0] - b[0]); } else if (s > top[0][0]) {
      top[0] = [s, refs[i]];
      top.sort((a, b) => a[0] - b[0]);
    }
  }
  return top.sort((a, b) => b[0] - a[0]);
}

// The same columns search() returns, for records found by vector, with the search filters applied.
const ROW_SQL = {
  obs: { sql: `SELECT o.id, o.project, o.type type, COALESCE(o.title, substr(o.narrative, 1, 100)) title, o.created_at FROM observations o WHERE o.id = ?`, time: 'created_at' },
  sum: { sql: `SELECT s.id, s.project, 'summary' type, s.request title, s.created_at FROM summaries s WHERE s.id = ?`, time: 'created_at' },
  item: { sql: `SELECT i.id, i.project, i.kind type, i.title, i.updated_at created_at FROM items i WHERE i.id = ?`, time: 'created_at' },
};

function rowFor(db, ref, o) {
  const kind = ref[0] === 'S' ? 'sum' : ref[0] === 'I' ? 'item' : 'obs';
  const row = db.prepare(ROW_SQL[kind].sql).get(Number(ref.replace(/^[SI]/, '')));
  if (!row) return null;
  if (o.project && String(row.project).toLowerCase() !== o.project.toLowerCase()) return null;
  if (o.type && row.type !== o.type) return null;
  const start = o.dateStart ? Date.parse(o.dateStart) : null;
  const end = o.dateEnd ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(o.dateEnd) ? `${o.dateEnd}T23:59:59.999Z` : o.dateEnd) : null;
  if (start != null && row.created_at < start) return null;
  if (end != null && row.created_at > end) return null;
  return { ...row, kind };
}

const KINDS = { all: ['obs', 'sum', 'item'], observations: ['obs'], summaries: ['sum'], items: ['item'], notes: ['item'], tasks: ['item'] };

// Full-text and vector results merged by reciprocal rank fusion. Falls back to plain full-text search when there is
// no query, no vectors, a game holds the GPU, or Ollama does not answer in QUERY_TIMEOUT_MS.
export async function hybridSearch(db, opts, settings = {}) {
  const o = normalizeSearch(opts);
  const fts = () => search(db, opts);
  // Later pages rank the same fused pool, so paging never skips or repeats a record (full-text past MAX_POOL).
  const pool = Math.max(POOL, o.offset + o.limit);
  if (!o.query || !embedEnabled(settings) || pool > MAX_POOL) return fts();
  if (Date.now() - Number(getMeta(db, 'busy_seen_at') || 0) < 60000) return fts();
  if (!db.prepare('SELECT 1 FROM embeddings WHERE model = ? LIMIT 1').get(settings.embedModel)) return fts();
  let q;
  try { [q] = await embed(settings, [o.query], QUERY_TIMEOUT_MS); } catch { return fts(); }
  const kind = o.kind === 'notes' ? 'notes' : o.kind === 'tasks' ? 'tasks' : o.kind;
  const type = o.kind === 'notes' ? 'note' : o.kind === 'tasks' ? 'task' : o.type;
  const textRows = search(db, { ...opts, limit: pool, offset: 0 });
  const vecRows = [];
  for (const [, ref] of nearest(db, settings.embedModel, q, new Set(KINDS[kind] || KINDS.all), pool * 3)) {
    const row = rowFor(db, ref, { ...o, type });
    if (row) vecRows.push(row);
    if (vecRows.length >= pool) break;
  }
  const score = new Map();
  const add = (rows) => rows.forEach((r, i) => {
    const id = refId(r);
    const cur = score.get(id) || { row: r, s: 0 };
    cur.s += 1 / (RRF_K + i + 1);
    score.set(id, cur);
  });
  add(textRows);
  add(vecRows);
  return [...score.values()].sort((a, b) => b.s - a.s).slice(o.offset, o.offset + o.limit).map((x) => x.row);
}

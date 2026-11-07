// Reads and writes of memory records. Pure functions over an open db handle.
import { redactText } from './redact.mjs';

const OBS_COLS = ['session_id', 'project', 'prompt_number', 'type', 'title', 'subtitle', 'narrative', 'facts',
  'concepts', 'files_read', 'files_modified', 'tool', 'created_at', 'source', 'source_id',
  'cwd', 'device', 'git_branch', 'git_commit', 'model', 'metadata'];
const SUM_COLS = ['session_id', 'project', 'prompt_number', 'request', 'investigated', 'learned', 'completed',
  'next_steps', 'notes', 'created_at', 'source', 'source_id',
  'cwd', 'device', 'git_branch', 'git_commit', 'files_read', 'files_modified', 'model', 'metadata'];
const NUMERIC = new Set(['prompt_number', 'created_at']);

export const asText = (v) => {
  if (v == null || v === '') return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return redactText(s);
};

function insertRow(db, table, cols, row, conflict) {
  const values = cols.map((c) => {
    const v = row[c];
    if (NUMERIC.has(c)) return v == null ? null : Number(v);
    if (c === 'source') return v || 'native';
    return asText(v);
  });
  const sql = `INSERT ${conflict} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  const res = db.prepare(sql).run(...values);
  return res.changes ? Number(res.lastInsertRowid) : null;
}

export const insertObservation = (db, row, conflict = 'OR IGNORE') => insertRow(db, 'observations', OBS_COLS, row, conflict);

// What the LLM writes about a tool call; the rest of a row (session, time, files, source) never changes.
const OBS_CONTENT = ['type', 'title', 'subtitle', 'narrative', 'facts', 'concepts', 'model', 'metadata'];

// Server side of sync: a row a client pushes again (an observation it upgraded) replaces the copy, keeping its id.
export function upsertObservation(db, row) {
  const values = OBS_COLS.map((c) => (NUMERIC.has(c) ? (row[c] == null ? null : Number(row[c])) : c === 'source' ? row.source || 'native' : asText(row[c])));
  const res = db.prepare(`INSERT INTO observations (${OBS_COLS.join(', ')}) VALUES (${OBS_COLS.map(() => '?').join(', ')})
    ON CONFLICT (source, source_id) DO UPDATE SET ${OBS_CONTENT.map((c) => `${c} = excluded.${c}`).join(', ')}`).run(...values);
  return res.changes > 0;
}

// A raw observation (stored without the LLM) gets the LLM's version in place: same id and time, pushed again.
// Returns false when the row is gone or already has an LLM version.
export function upgradeObservation(db, id, obs, model) {
  const res = db.prepare(`UPDATE observations SET type = ?, title = ?, subtitle = ?, narrative = ?, facts = ?, concepts = ?, model = ?,
      metadata = json_set(COALESCE(metadata, '{}'), '$.compressed', json('true'), '$.backfilled', json('true')), synced_at = NULL
    WHERE id = ? AND json_extract(metadata, '$.compressed') = 0`)
    .run(asText(obs.type), asText(obs.title), asText(obs.subtitle), asText(obs.narrative), asText(obs.facts), asText(obs.concepts), model ?? null, id);
  return res.changes > 0;
}
export const insertSummary = (db, row, conflict = 'OR IGNORE') => insertRow(db, 'summaries', SUM_COLS, row, conflict);

export function upsertSummary(db, row) {
  const existing = db.prepare('SELECT id FROM summaries WHERE source = ? AND source_id = ?')
    .get(row.source || 'native', row.source_id);
  if (existing) db.prepare('DELETE FROM summaries WHERE id = ?').run(existing.id);
  return insertSummary(db, row);
}

// --- sessions & prompts --------------------------------------------------
export function ensureSession(db, { sessionId, project, cwd, device, gitBranch, gitCommit }) {
  db.prepare(`INSERT INTO sessions (session_id, project, cwd, started_at, device, git_branch, git_commit, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
      git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
      git_commit = COALESCE(excluded.git_commit, sessions.git_commit),
      device = COALESCE(sessions.device, excluded.device)`)
    .run(sessionId, project, cwd ?? null, Date.now(), device ?? null, gitBranch ?? null, gitCommit ?? null, Date.now());
}

export function sessionInfo(db, sessionId) {
  return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) ?? null;
}

export function addPrompt(db, { sessionId, project, cwd, device, text }) {
  ensureSession(db, { sessionId, project, cwd, device });
  const { prompt_counter: n } = db.prepare(
    'UPDATE sessions SET prompt_counter = prompt_counter + 1 WHERE session_id = ? RETURNING prompt_counter',
  ).get(sessionId);
  db.prepare('INSERT INTO prompts (session_id, project, prompt_number, text, created_at, cwd, device) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, project, n, redactText(text), Date.now(), cwd ?? null, device ?? null);
  return n;
}

export function currentPromptNumber(db, sessionId) {
  return db.prepare('SELECT prompt_counter FROM sessions WHERE session_id = ?').get(sessionId)?.prompt_counter ?? 0;
}

export function promptText(db, sessionId, promptNumber) {
  return db.prepare('SELECT text FROM prompts WHERE session_id = ? AND prompt_number = ? ORDER BY id DESC LIMIT 1')
    .get(sessionId, promptNumber)?.text ?? '';
}

export function turnObservations(db, sessionId, promptNumber) {
  return db.prepare(`SELECT id, type, title, subtitle, narrative, files_read, files_modified, tool FROM observations
    WHERE session_id = ? AND prompt_number = ? ORDER BY id`).all(sessionId, promptNumber);
}

// Ids already shown to Claude in this session, so recall never repeats itself.
export function injectedRefs(db, sessionId) {
  try { return new Set(JSON.parse(sessionInfo(db, sessionId)?.injected || '[]')); } catch { return new Set(); }
}

export function markInjected(db, sessionId, refs) {
  if (!sessionId || !refs.length) return;
  const all = [...new Set([...injectedRefs(db, sessionId), ...refs])].slice(-500);
  db.prepare('UPDATE sessions SET injected = ? WHERE session_id = ?').run(JSON.stringify(all), sessionId);
}

// --- recall usefulness ------------------------------------------------------
// Paths compared case- and slash-insensitively, stored as "|a|b|" so one instr() finds a file.
const normPath = (f) => String(f || '').replace(/\\/g, '/').toLowerCase();

export function logRecall(db, sessionId, rows) {
  const ins = db.prepare('INSERT OR IGNORE INTO recall_log (session_id, ref, files, shown_at) VALUES (?, ?, ?, ?)');
  for (const r of rows) {
    const files = (r.files || []).map(normPath).filter(Boolean);
    ins.run(sessionId, refId(r), files.length ? `|${files.join('|')}|` : null, Date.now());
  }
}

// The session used what recall showed it: fetched records (refs) or a tool touched one of their files.
export function markRecallUsed(db, sessionId, { refs = [], file } = {}) {
  const upd = db.prepare('UPDATE recall_log SET used = 1 WHERE session_id = ? AND ref = ? AND used = 0');
  for (const ref of refs) upd.run(sessionId, String(ref).trim().toUpperCase());
  if (file) {
    db.prepare("UPDATE recall_log SET used = 1 WHERE session_id = ? AND used = 0 AND instr(files, ?) > 0")
      .run(sessionId, `|${normPath(file)}|`);
  }
}

// Records recall showed in at least `minShown` sessions without any of them using it: noise, not recalled again.
export function mutedRefs(db, minShown) {
  if (!minShown) return [];
  return db.prepare('SELECT ref FROM recall_log GROUP BY ref HAVING count(*) >= ? AND max(used) = 0').all(minShown).map((r) => r.ref);
}

export function recallStats(db, minShown) {
  const t = db.prepare('SELECT count(*) shown, coalesce(sum(used), 0) used, count(DISTINCT session_id) sessions FROM recall_log').get();
  return { ...t, muted: mutedRefs(db, minShown).length };
}

export function pruneRecallLog(db, days = 90) {
  return Number(db.prepare('DELETE FROM recall_log WHERE shown_at < ?').run(Date.now() - days * 86400000).changes);
}

// --- search ---------------------------------------------------------------
// "foo bar-baz" -> "foo"* "bar"* "baz"*  (AND) or joined with OR.
export function ftsTerms(query) {
  return (String(query || '').match(/[\p{L}\p{N}_]+/gu) || []).slice(0, 24);
}

export function ftsQuery(query, mode = 'and') {
  const terms = ftsTerms(query);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(mode === 'or' ? ' OR ' : ' ');
}

function toEpoch(value, endOfDay = false) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  const s = String(value);
  const t = Date.parse(endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59.999Z` : s);
  return Number.isNaN(t) ? null : t;
}

const TABLES = {
  obs: { table: 'observations', fts: 'obs_fts', alias: 'o', type: 'o.type', title: 'COALESCE(o.title, substr(o.narrative, 1, 100))', time: 'o.created_at' },
  sum: { table: 'summaries', fts: 'sum_fts', alias: 's', type: "'summary'", title: 's.request', time: 's.created_at' },
  item: { table: 'items', fts: 'items_fts', alias: 'i', type: 'i.kind', title: 'i.title', time: 'i.updated_at' },
};

// FROM + WHERE of one table for a normalized search; null when the query has no searchable term.
function searchFilter(kind, o, mode) {
  const t = TABLES[kind];
  const params = [];
  const match = o.query ? ftsQuery(o.query, mode) : null;
  if (o.query && !match) return null;
  const where = match ? [`${t.fts} MATCH ?`] : [];
  if (match) params.push(match);
  // With a MATCH, unary + keeps SQLite from picking a table index as the outer loop: that plan runs the
  // full-text query once per row of the project (~20 s on a 50k-record memory) instead of once.
  const col = (c) => (match ? `+${c}` : c);
  if (o.project) { where.push(`${col(`${t.alias}.project`)} = ? COLLATE NOCASE`); params.push(o.project); }
  if (o.type && kind === 'obs') { where.push(`${col('o.type')} = ?`); params.push(o.type); }
  if (o.type && kind === 'item') { where.push(`${col('i.kind')} = ?`); params.push(o.type); }
  const start = toEpoch(o.dateStart);
  const end = toEpoch(o.dateEnd, true);
  if (start != null) { where.push(`${col(t.time)} >= ?`); params.push(start); }
  if (end != null) { where.push(`${col(t.time)} <= ?`); params.push(end); }
  const from = match ? `${t.fts} JOIN ${t.table} ${t.alias} ON ${t.alias}.id = ${t.fts}.rowid` : `${t.table} ${t.alias}`;
  return { t, match, from: `${from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, params };
}

function searchTable(db, kind, o, mode) {
  const f = searchFilter(kind, o, mode);
  if (!f) return [];
  const { t, match } = f;
  const sql = `SELECT ${t.alias}.id AS id, ${t.alias}.project AS project, ${t.type} AS type, ${t.title} AS title,
      ${t.time} AS created_at, ${match ? `bm25(${t.fts})` : '0'} AS rank
    FROM ${f.from} ORDER BY ${match ? 'rank' : `${t.time} DESC`} LIMIT ?`;
  return db.prepare(sql).all(...f.params, o.limit + o.offset).map((r) => ({ ...r, kind }));
}

export function normalizeSearch(opts = {}) {
  return {
    query: String(opts.query ?? '').trim(),
    project: opts.project || null,
    type: opts.type || null,
    kind: opts.kind || 'all',
    limit: Math.min(Math.max(Number(opts.limit) || 20, 1), 100),
    offset: Math.max(Number(opts.offset) || 0, 0),
    dateStart: opts.dateStart,
    dateEnd: opts.dateEnd,
  };
}

const KIND_SETS = { all: ['obs', 'sum', 'item'], observations: ['obs'], summaries: ['sum'], items: ['item'], notes: ['item'], tasks: ['item'] };

function searchKinds(o) {
  if (o.kind === 'notes') o.type = 'note';
  if (o.kind === 'tasks') o.type = 'task';
  return (KIND_SETS[o.kind] || KIND_SETS.all).filter((k) => !(o.type && k === 'sum') && !(o.type && k === 'item' && !['note', 'task'].includes(o.type)) && !(o.type && k === 'obs' && ['note', 'task'].includes(o.type)));
}

// How many records `search` can page through: every term first, any term when none matches all (as `search`).
export function searchCount(db, opts = {}) {
  const o = normalizeSearch(opts);
  const kinds = searchKinds(o);
  const count = (mode) => kinds.reduce((n, k) => {
    const f = searchFilter(k, o, mode);
    return n + (f ? db.prepare(`SELECT count(*) n FROM ${f.from}`).get(...f.params).n : 0);
  }, 0);
  const n = count('and');
  return n || !o.query ? n : count('or');
}

export function search(db, opts = {}) {
  const o = normalizeSearch(opts);
  const kinds = searchKinds(o);
  const run = (mode) => {
    const rows = kinds.flatMap((k) => searchTable(db, k, o, mode));
    rows.sort(o.query ? (a, b) => a.rank - b.rank : (a, b) => b.created_at - a.created_at);
    return rows.slice(o.offset, o.offset + o.limit);
  };
  let rows = run('and');
  if (!rows.length && o.query) rows = run('or');
  return rows;
}

// --- prompt-time recall ----------------------------------------------------
const STOP = new Set(('that this with from have what when where which there their about would could should into your '
  + 'then than them they were will just also like make need want sure please using used para pero como esta este esto '
  + 'esos esas todo todos toda todas hacer haya sobre desde donde cuando porque tiene tienen puede pueden quiero '
  + 'quieres ahora antes despues bien solo sólo algo cada otra otro otros muchas mucho entre hasta según mira dime '
  + 'revisa favor gracias').split(' '));

export function recallTerms(prompt) {
  const seen = new Set();
  const terms = [];
  for (const raw of ftsTerms(prompt)) {
    const t = raw.toLowerCase();
    if (t.length < 4 || STOP.has(t) || /^\d+$/.test(t) || seen.has(t)) continue;
    seen.add(t);
    terms.push(t);
  }
  return terms.slice(0, 8);
}

const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

// Records that share at least two informative words with the prompt, best first.
export function recall(db, { prompt, project, exclude = new Set(), limit = 5 }) {
  const terms = recallTerms(prompt);
  if (terms.length < 2) return [];
  // OR match, then rerank: plain AND is too strict for natural-language prompts.
  const o = normalizeSearch({ query: terms.join(' '), project, limit: 40 });
  const rows = ['obs', 'sum', 'item'].flatMap((k) => searchTable(db, k, o, 'or'));
  const folded = terms.map(fold);
  const scored = rows
    .filter((r) => !exclude.has(refId(r)))
    .map((r) => {
      const text = fold(`${r.title} ${r.type}`);
      const hits = folded.filter((t) => text.includes(t)).length;
      return { ...r, hits };
    });
  // Title hits are a strong signal; fall back to FTS rank for body-only matches.
  const need = Math.min(2, terms.length);
  const strong = scored.filter((r) => r.hits >= need);
  const pool = strong.length ? strong : scored.filter((r) => r.rank < -8);
  pool.sort((a, b) => b.hits - a.hits || a.rank - b.rank);
  // Files of each record, so the client can tell later whether the session worked on them (recall usefulness).
  return pool.slice(0, limit).map((r) => {
    if (r.kind === 'item') return r;
    const f = db.prepare(`SELECT files_read, files_modified FROM ${TABLES[r.kind].table} WHERE id = ?`).get(r.id) || {};
    const files = [f.files_read, f.files_modified].flatMap((x) => { try { return JSON.parse(x || '[]'); } catch { return []; } });
    return { ...r, files: [...new Set(files)].slice(0, 20) };
  });
}

// --- refs -------------------------------------------------------------------
export function refId(row) {
  if (row.kind === 'sum') return `S${row.id}`;
  if (row.kind === 'item') return `I${row.id}`;
  return `${row.id}`;
}

export function parseRef(ref) {
  const m = String(ref).trim().match(/^([sSiI]?)(\d+)$/);
  if (!m) return null;
  const p = m[1].toUpperCase();
  return { kind: p === 'S' ? 'sum' : p === 'I' ? 'item' : 'obs', id: Number(m[2]) };
}

export function getByRefs(db, refs) {
  const out = [];
  for (const ref of refs.slice(0, 50)) {
    const r = parseRef(ref);
    if (!r) continue;
    const row = db.prepare(`SELECT * FROM ${TABLES[r.kind].table} WHERE id = ?`).get(r.id);
    if (!row) continue;
    const rec = { ...row, item_kind: r.kind === 'item' ? row.kind : undefined, kind: r.kind };
    if (r.kind === 'item') rec.events = db.prepare('SELECT at, event, from_status, to_status, detail, device FROM item_events WHERE item_id = ? ORDER BY at').all(r.id);
    out.push(rec);
  }
  return out;
}

export function timeline(db, anchorRef, before = 5, after = 5) {
  const r = parseRef(anchorRef);
  if (!r || r.kind === 'item') return null;
  const t = TABLES[r.kind];
  const anchor = db.prepare(`SELECT id, project, created_at FROM ${t.table} WHERE id = ?`).get(r.id);
  if (!anchor) return null;
  const sel = (kind, cmp, dir, n) => {
    const x = TABLES[kind];
    return db.prepare(`SELECT ${x.alias}.id AS id, ${x.alias}.project AS project, ${x.type} AS type, ${x.title} AS title,
        ${x.alias}.created_at AS created_at FROM ${x.table} ${x.alias}
      WHERE ${x.alias}.project = ? COLLATE NOCASE
        AND (${x.alias}.created_at ${cmp} ? OR (${x.alias}.created_at = ? AND ${x.alias}.id ${cmp} ?))
      ORDER BY ${x.alias}.created_at ${dir}, ${x.alias}.id ${dir} LIMIT ?`)
      .all(anchor.project, anchor.created_at, anchor.created_at, r.kind === kind ? anchor.id : -1, n)
      .map((row) => ({ ...row, kind }));
  };
  const merge = (cmp, dir, n) => [...sel('obs', cmp, dir, n), ...sel('sum', cmp, dir, n)]
    .sort((a, b) => (dir === 'DESC' ? b.created_at - a.created_at : a.created_at - b.created_at)).slice(0, n);
  const self = db.prepare(`SELECT ${t.alias}.id AS id, ${t.alias}.project AS project, ${t.type} AS type, ${t.title} AS title,
      ${t.alias}.created_at AS created_at FROM ${t.table} ${t.alias} WHERE ${t.alias}.id = ?`).get(r.id);
  return [...merge('<', 'DESC', before).reverse(), { ...self, kind: r.kind, anchor: true }, ...merge('>', 'ASC', after)];
}

// --- maintenance --------------------------------------------------------------
// Re-applies redaction to rows stored before redaction existed (or after patterns improve).
export function redactExisting(db) {
  const targets = [
    ['observations', ['title', 'subtitle', 'narrative', 'facts', 'concepts']],
    ['summaries', ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes']],
    ['prompts', ['text']],
    ['items', ['title', 'body']],
  ];
  let changed = 0;
  for (const [table, cols] of targets) {
    const rows = db.prepare(`SELECT id, ${cols.join(', ')} FROM ${table}`).all();
    const upd = db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) {
        const next = cols.map((c) => redactText(r[c]) ?? null);
        if (next.some((v, i) => v !== (r[cols[i]] ?? null))) { upd.run(...next, r.id); changed++; }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  db.exec("INSERT INTO obs_fts (obs_fts) VALUES ('optimize'); INSERT INTO sum_fts (sum_fts) VALUES ('optimize');");
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;'); // drop old pages that still hold the secrets
  return changed;
}

export function stats(db) {
  const count = (sql) => db.prepare(sql).get().n;
  return {
    observations: count('SELECT count(*) n FROM observations'),
    summaries: count('SELECT count(*) n FROM summaries'),
    prompts: count('SELECT count(*) n FROM prompts'),
    notes: count("SELECT count(*) n FROM items WHERE kind = 'note'"),
    tasks: count("SELECT count(*) n FROM items WHERE kind = 'task'"),
    imported: count("SELECT count(*) n FROM observations WHERE source LIKE 'claude-mem%'"),
    unsynced: count('SELECT (SELECT count(*) FROM observations WHERE synced_at IS NULL) + (SELECT count(*) FROM summaries WHERE synced_at IS NULL) + (SELECT count(*) FROM prompts WHERE synced_at IS NULL) + (SELECT count(*) FROM items WHERE synced_at IS NULL) n'),
    queuePending: count("SELECT count(*) n FROM queue WHERE status IN ('pending', 'processing')"),
    queueFailed: count("SELECT count(*) n FROM queue WHERE status = 'failed'"),
    projects: db.prepare('SELECT project, count(*) n FROM observations GROUP BY project COLLATE NOCASE ORDER BY n DESC LIMIT 10').all(),
  };
}

// --- formatting for Claude -------------------------------------------------------
export const day = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : '????-??-??');
export const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function formatIndex(rows) {
  if (!rows.length) return 'No results.';
  return rows.map((r) => `${r.anchor ? '>> ' : ''}${refId(r)} · ${day(r.created_at)} · ${r.project} · ${r.type || '-'} · ${clip(r.title, 140)}`).join('\n');
}

export const listField = (v) => {
  if (!v) return '';
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.map((x) => `- ${x}`).join('\n') : String(v);
  } catch {
    return String(v);
  }
};

const nonEmptyList = (v) => v && v !== '[]' && v !== 'null';

function metaLine(r) {
  const bits = [r.device && `device ${r.device}`, r.git_branch && `branch ${r.git_branch}`, r.git_commit && `commit ${String(r.git_commit).slice(0, 10)}`,
    r.cwd && `cwd ${r.cwd}`, r.tool && `tool ${r.tool}`, r.session_id && `session ${String(r.session_id).slice(0, 8)}`,
    r.prompt_number && `prompt #${r.prompt_number}`].filter(Boolean);
  return bits.length ? `Context: ${bits.join(', ')}` : '';
}

export function formatFull(rows) {
  if (!rows.length) return 'No records found.';
  return rows.map((r) => {
    if (r.kind === 'sum') {
      return [`## S${r.id} · ${day(r.created_at)} · ${r.project} · summary`,
        r.request && `Request: ${r.request}`, r.investigated && `Investigated: ${r.investigated}`,
        r.learned && `Learned: ${r.learned}`, r.completed && `Completed: ${r.completed}`,
        r.next_steps && `Next steps: ${r.next_steps}`, r.notes && `Notes: ${r.notes}`,
        nonEmptyList(r.files_modified) && `Files modified:\n${listField(r.files_modified)}`, metaLine(r)].filter(Boolean).join('\n');
    }
    if (r.kind === 'item') {
      const history = (r.events || []).map((e) => `- ${day(e.at)} ${e.event}${e.to_status ? ` → ${e.to_status}` : ''}${e.detail ? `: ${clip(e.detail, 160)}` : ''}`).join('\n');
      return [`## I${r.id} · ${day(r.created_at)} · ${r.project || '-'} · ${r.item_kind}${r.status ? ` [${r.status}]` : ''}`,
        `# ${r.title}`, r.body, r.directory && `Directory: ${r.directory}`, r.due_at && `Due: ${day(r.due_at)}`,
        nonEmptyList(r.tags) && `Tags: ${listField(r.tags).replace(/\n/g, ' ')}`, history && `History:\n${history}`].filter(Boolean).join('\n');
    }
    return [`## ${r.id} · ${day(r.created_at)} · ${r.project} · ${r.type || '-'}`, r.title && `# ${r.title}`,
      r.subtitle, r.narrative, r.facts && `Facts:\n${listField(r.facts)}`,
      nonEmptyList(r.files_modified) && `Files modified:\n${listField(r.files_modified)}`,
      nonEmptyList(r.files_read) && `Files read:\n${listField(r.files_read)}`, metaLine(r)].filter(Boolean).join('\n');
  }).join('\n\n');
}

export function formatRecall(rows) {
  if (!rows.length) return '';
  return ['# open-mem: memory related to this prompt (fetch details with get_observations only if needed)',
    ...rows.map((r) => `- ${refId(r)} · ${day(r.created_at)} · ${r.project} · ${r.type || '-'} · ${clip(r.title, 150)}`)].join('\n');
}

// --- session-start context ---------------------------------------------------------
function hotFiles(db, project, limit = 8) {
  const since = Date.now() - 30 * 24 * 3600 * 1000;
  const counts = new Map();
  for (const r of db.prepare(`SELECT files_modified FROM observations WHERE project = ? COLLATE NOCASE AND created_at >= ?
      AND files_modified IS NOT NULL AND files_modified != '[]' ORDER BY created_at DESC LIMIT 400`).iterate(project, since)) {
    try { for (const f of JSON.parse(r.files_modified)) counts.set(f, (counts.get(f) || 0) + 1); } catch { /* skip */ }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// The last LLM review of a project's notes: { at, flags: [{ ids, kind, reason }] } (written by the drainer).
export const reviewKey = (project) => `notes_review:${String(project).toLowerCase()}`;
export function notesReview(db, project) {
  try { return JSON.parse(db.prepare('SELECT value FROM meta WHERE key = ?').get(reviewKey(project))?.value || 'null'); } catch { return null; }
}

// Repeated mistakes the LLM proposes for a project's "known mistakes" list: { at, lessons: [{ ids, rule }] }.
export const lessonsKey = (project) => `lessons:${String(project).toLowerCase()}`;
export function lessons(db, project) {
  try { return JSON.parse(db.prepare('SELECT value FROM meta WHERE key = ?').get(lessonsKey(project))?.value || 'null'); } catch { return null; }
}

// The last stretch of work before `until` across every project: the newest summary before it and those within
// RECAP_SPAN_MS of it, newest first. Shown in the first session of the day ("what did I do last night?").
const RECAP_SPAN_MS = 16 * 3600 * 1000;
export function recapBefore(db, until, limit = 15) {
  const rows = db.prepare(`SELECT id, project, request, completed, created_at FROM summaries WHERE created_at < ?
    ORDER BY created_at DESC LIMIT 60`).all(until);
  if (!rows.length) return [];
  return rows.filter((r) => r.created_at >= rows[0].created_at - RECAP_SPAN_MS).slice(0, limit);
}

// Clock time in the client's zone (tz = its getTimezoneOffset(), minutes behind UTC).
const clock = (ms, tz = 0) => new Date(Number(ms) - tz * 60000).toISOString().slice(11, 16);

export function contextFor(db, project, settings, { cwd, recap } = {}) {
  const sums = db.prepare(`SELECT id, request, completed, next_steps, created_at FROM summaries
    WHERE project = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`).all(project, settings.contextSummaries);
  const obs = db.prepare(`SELECT id, type, title, narrative, created_at FROM observations
    WHERE project = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`).all(project, settings.contextObservations);
  const tasks = db.prepare(`SELECT id, title, status, priority, due_at, directory FROM items
    WHERE kind = 'task' AND project = ? COLLATE NOCASE AND status IN ('todo', 'doing', 'blocked')
    ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END, priority, updated_at DESC LIMIT ?`).all(project, settings.contextTasks);
  const notes = db.prepare(`SELECT id, title FROM items WHERE kind = 'note' AND project = ? COLLATE NOCASE
    ORDER BY updated_at DESC LIMIT 5`).all(project);
  const brief = db.prepare('SELECT body, generated_at FROM briefs WHERE project = ?').get(project);
  const lines = [`# open-mem — project "${project}"${cwd ? ` (${cwd})` : ''}`];
  const refs = [];
  if (!sums.length && !obs.length && !tasks.length && !brief) {
    lines.push('No memory yet for this project. It builds up as you work.');
  }
  if (recap?.until) {
    const last = recapBefore(db, Number(recap.until));
    if (last.length) {
      lines.push('', `## Last working session (${day(last[0].created_at)}, every project) — first session today`);
      for (const r of last) {
        refs.push(`S${r.id}`);
        lines.push(`- S${r.id} ${clock(r.created_at, Number(recap.tz) || 0)} · ${r.project}: ${clip(r.request, 120)}${r.completed ? ` → ${clip(r.completed, 160)}` : ''}`);
      }
    }
  }
  if (brief) lines.push('', `## Project brief (${day(brief.generated_at)})`, brief.body.trim());
  if (tasks.length) {
    lines.push('', '## Open tasks');
    for (const t of tasks) {
      refs.push(`I${t.id}`);
      lines.push(`- I${t.id} [${t.status}] ${clip(t.title, 120)}${t.due_at ? ` (due ${day(t.due_at)})` : ''}`);
    }
  }
  if (sums.length) {
    lines.push('', '## Recent sessions');
    for (const s of sums) {
      refs.push(`S${s.id}`);
      lines.push(`- S${s.id} ${day(s.created_at)}: ${clip(s.request, 140)}${s.completed ? ` → ${clip(s.completed, 180)}` : ''}`);
    }
    if (sums[0].next_steps) lines.push(`  Next steps left last time: ${clip(sums[0].next_steps, 300)}`);
  }
  const files = hotFiles(db, project);
  if (files.length) lines.push('', '## Most-edited files (30 days)', files.map(([f, n]) => `${f} (${n})`).join(', '));
  if (notes.length) {
    lines.push('', '## Notes', ...notes.map((n) => `- I${n.id} ${clip(n.title, 120)}`));
    refs.push(...notes.map((n) => `I${n.id}`));
  }
  const review = notesReview(db, project);
  if (review?.flags?.length) {
    lines.push('', `## Notes that may need fixing (review of ${day(review.at)}; once confirmed, fix or archive them with task_update)`,
      ...review.flags.map((f) => `- ${f.ids.join(', ')} ${f.kind}: ${clip(f.reason, 200)}`));
  }
  if (obs.length) {
    lines.push('', '## Recent observations');
    for (const o of obs) {
      refs.push(`${o.id}`);
      lines.push(`- ${o.id} · ${day(o.created_at)} · ${o.type || '-'} · ${clip(o.title || o.narrative, 120)}`);
    }
  }
  lines.push('', OPERATING_RULES);
  return { text: lines.join('\n'), refs };
}

export const OPERATING_RULES = `## How to use open-mem
- This context replaces re-exploring the project: trust it, and only read files the task actually needs.
- More detail: search(query) → timeline(anchor) → get_observations(ids). Fetch only what you need.
- Durable to-dos: task_add / task_update (status todo → doing → done) — not TodoWrite — for anything that must outlive this session; keep their status current as you work.
- Decisions, conventions, gotchas, user preferences: note_add. Notes and tasks belong to the current project/directory unless the user says otherwise.`;

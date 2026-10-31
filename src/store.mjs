// Reads and writes of memory rows. Pure functions over an open db handle.

const OBS_COLS = ['session_id', 'project', 'prompt_number', 'type', 'title', 'subtitle', 'narrative', 'facts',
  'concepts', 'files_read', 'files_modified', 'tool', 'created_at', 'source', 'source_id'];
const SUM_COLS = ['session_id', 'project', 'prompt_number', 'request', 'investigated', 'learned', 'completed',
  'next_steps', 'notes', 'created_at', 'source', 'source_id'];

const asText = (v) => (v == null ? null : Array.isArray(v) ? JSON.stringify(v) : String(v));

function insertRow(db, table, cols, row, conflict) {
  const values = cols.map((c) => {
    const v = row[c];
    if (c === 'prompt_number' || c === 'created_at') return v == null ? null : Number(v);
    if (c === 'source') return v || 'native';
    return asText(v);
  });
  const sql = `INSERT ${conflict} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  const res = db.prepare(sql).run(...values);
  return res.changes ? Number(res.lastInsertRowid) : null;
}

export const insertObservation = (db, row, conflict = 'OR IGNORE') => insertRow(db, 'observations', OBS_COLS, row, conflict);
export const insertSummary = (db, row, conflict = 'OR IGNORE') => insertRow(db, 'summaries', SUM_COLS, row, conflict);

export function upsertSummary(db, row) {
  const existing = db.prepare('SELECT id FROM summaries WHERE source = ? AND source_id = ?')
    .get(row.source || 'native', row.source_id);
  if (existing) db.prepare('DELETE FROM summaries WHERE id = ?').run(existing.id);
  return insertSummary(db, row);
}

export function ensureSession(db, { sessionId, project, cwd }) {
  db.prepare(`INSERT INTO sessions (session_id, project, cwd, started_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (session_id) DO NOTHING`).run(sessionId, project, cwd ?? null, Date.now());
}

export function addPrompt(db, { sessionId, project, cwd, text }) {
  ensureSession(db, { sessionId, project, cwd });
  const { prompt_counter: n } = db.prepare(
    'UPDATE sessions SET prompt_counter = prompt_counter + 1 WHERE session_id = ? RETURNING prompt_counter',
  ).get(sessionId);
  db.prepare('INSERT INTO prompts (session_id, project, prompt_number, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, project, n, text, Date.now());
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
  return db.prepare(`SELECT id, type, title, subtitle, narrative, files_modified, tool FROM observations
    WHERE session_id = ? AND prompt_number = ? ORDER BY id`).all(sessionId, promptNumber);
}

// "foo bar-baz" -> "foo"* "bar"* "baz"*  (AND) or joined with OR.
export function ftsQuery(query, mode = 'and') {
  const terms = String(query || '').match(/[\p{L}\p{N}_]+/gu) || [];
  if (!terms.length) return null;
  return terms.slice(0, 24).map((t) => `"${t}"*`).join(mode === 'or' ? ' OR ' : ' ');
}

function filters(alias, { project, type, dateStart, dateEnd }, params) {
  const where = [];
  if (project) { where.push(`${alias}.project = ? COLLATE NOCASE`); params.push(project); }
  if (type && alias === 'o') { where.push('o.type = ?'); params.push(type); }
  const start = toEpoch(dateStart);
  const end = toEpoch(dateEnd, true);
  if (start != null) { where.push(`${alias}.created_at >= ?`); params.push(start); }
  if (end != null) { where.push(`${alias}.created_at <= ?`); params.push(end); }
  return where;
}

function toEpoch(value, endOfDay = false) {
  if (!value) return null;
  const s = String(value);
  const t = Date.parse(endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59.999Z` : s);
  return Number.isNaN(t) ? null : t;
}

function searchTable(db, kind, opts, mode) {
  const isObs = kind === 'observations';
  const alias = isObs ? 'o' : 's';
  const table = isObs ? 'observations' : 'summaries';
  const fts = isObs ? 'obs_fts' : 'sum_fts';
  const titleExpr = isObs ? "COALESCE(o.title, substr(o.narrative, 1, 100))" : 's.request';
  const typeExpr = isObs ? 'o.type' : "'summary'";
  const params = [];
  const match = opts.query ? ftsQuery(opts.query, mode) : null;
  if (opts.query && !match) return [];
  const where = match ? [`${fts} MATCH ?`] : [];
  if (match) params.push(match);
  where.push(...filters(alias, opts, params));
  const from = match ? `${fts} JOIN ${table} ${alias} ON ${alias}.id = ${fts}.rowid` : `${table} ${alias}`;
  const order = match ? `bm25(${fts})` : `${alias}.created_at DESC`;
  const sql = `SELECT ${alias}.id AS id, ${alias}.project AS project, ${typeExpr} AS type, ${titleExpr} AS title,
      ${alias}.created_at AS created_at ${match ? `, bm25(${fts}) AS rank` : ', 0 AS rank'}
    FROM ${from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${order} LIMIT ?`;
  params.push(opts.limit + opts.offset);
  return db.prepare(sql).all(...params).map((r) => ({ ...r, kind: isObs ? 'obs' : 'sum' }));
}

export function search(db, opts = {}) {
  const o = {
    query: opts.query?.trim() || '',
    project: opts.project || null,
    type: opts.type || null,
    kind: opts.kind || 'all',
    limit: Math.min(Math.max(Number(opts.limit) || 20, 1), 100),
    offset: Math.max(Number(opts.offset) || 0, 0),
    dateStart: opts.dateStart,
    dateEnd: opts.dateEnd,
  };
  const run = (mode) => {
    let rows = [];
    if (o.kind !== 'summaries') rows.push(...searchTable(db, 'observations', o, mode));
    if (o.kind !== 'observations' && !o.type) rows.push(...searchTable(db, 'summaries', o, mode));
    rows.sort(o.query ? (a, b) => a.rank - b.rank : (a, b) => b.created_at - a.created_at);
    return rows.slice(o.offset, o.offset + o.limit);
  };
  let rows = run('and');
  if (!rows.length && o.query) rows = run('or');
  return rows;
}

export function refId(row) {
  return row.kind === 'sum' ? `S${row.id}` : `${row.id}`;
}

function parseRef(ref) {
  const m = String(ref).trim().match(/^([sS]?)(\d+)$/);
  if (!m) return null;
  return { kind: m[1] ? 'sum' : 'obs', id: Number(m[2]) };
}

export function getByRefs(db, refs) {
  const out = [];
  for (const ref of refs.slice(0, 50)) {
    const r = parseRef(ref);
    if (!r) continue;
    const row = r.kind === 'obs'
      ? db.prepare('SELECT * FROM observations WHERE id = ?').get(r.id)
      : db.prepare('SELECT * FROM summaries WHERE id = ?').get(r.id);
    if (row) out.push({ ...row, kind: r.kind });
  }
  return out;
}

export function timeline(db, anchorRef, before = 5, after = 5) {
  const r = parseRef(anchorRef);
  if (!r) return null;
  const table = r.kind === 'obs' ? 'observations' : 'summaries';
  const anchor = db.prepare(`SELECT id, project, created_at FROM ${table} WHERE id = ?`).get(r.id);
  if (!anchor) return null;
  const sel = (t, kind, cmp, dir, n) => db.prepare(`SELECT id, project, ${t === 'observations' ? 'type, title' : "'summary' AS type, request AS title"},
      created_at, '${kind}' AS kind FROM ${t}
    WHERE project = ? COLLATE NOCASE AND (created_at ${cmp} ? OR (created_at = ? AND id ${cmp} ?))
    ORDER BY created_at ${dir}, id ${dir} LIMIT ?`).all(anchor.project, anchor.created_at, anchor.created_at, r.kind === kind ? anchor.id : -1, n); // same-instant rows of the other table land after the anchor
  const merge = (cmp, dir, n) => [...sel('observations', 'obs', cmp, dir, n), ...sel('summaries', 'sum', cmp, dir, n)]
    .sort((a, b) => (dir === 'DESC' ? b.created_at - a.created_at : a.created_at - b.created_at)).slice(0, n);
  const self = { ...db.prepare(`SELECT id, project, ${r.kind === 'obs' ? 'type, title' : "'summary' AS type, request AS title"}, created_at FROM ${table} WHERE id = ?`).get(r.id), kind: r.kind, anchor: true };
  return [...merge('<', 'DESC', before).reverse(), self, ...merge('>', 'ASC', after)];
}

export function stats(db) {
  const count = (sql) => db.prepare(sql).get().n;
  return {
    observations: count('SELECT count(*) n FROM observations'),
    summaries: count('SELECT count(*) n FROM summaries'),
    prompts: count('SELECT count(*) n FROM prompts'),
    imported: count("SELECT count(*) n FROM observations WHERE source = 'claude-mem'"),
    queuePending: count("SELECT count(*) n FROM queue WHERE status IN ('pending', 'processing')"),
    queueFailed: count("SELECT count(*) n FROM queue WHERE status = 'failed'"),
    projects: db.prepare('SELECT project, count(*) n FROM observations GROUP BY project COLLATE NOCASE ORDER BY n DESC LIMIT 10').all(),
  };
}

const day = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : '????-??-??');
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function formatIndex(rows) {
  if (!rows.length) return 'No results.';
  return rows.map((r) => `${r.anchor ? '>> ' : ''}${refId(r)} · ${day(r.created_at)} · ${r.project} · ${r.type || '-'} · ${clip(r.title, 140)}`).join('\n');
}

const listField = (v) => {
  if (!v) return '';
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.map((x) => `- ${x}`).join('\n') : String(v);
  } catch {
    return String(v);
  }
};

export function formatFull(rows) {
  if (!rows.length) return 'No records found.';
  return rows.map((r) => {
    if (r.kind === 'sum') {
      return [`## S${r.id} · ${day(r.created_at)} · ${r.project} · summary`,
        r.request && `Request: ${r.request}`, r.investigated && `Investigated: ${r.investigated}`,
        r.learned && `Learned: ${r.learned}`, r.completed && `Completed: ${r.completed}`,
        r.next_steps && `Next steps: ${r.next_steps}`, r.notes && `Notes: ${r.notes}`].filter(Boolean).join('\n');
    }
    return [`## ${r.id} · ${day(r.created_at)} · ${r.project} · ${r.type || '-'}`, r.title && `# ${r.title}`,
      r.subtitle, r.narrative, r.facts && `Facts:\n${listField(r.facts)}`,
      r.files_modified && r.files_modified !== '[]' && `Files modified:\n${listField(r.files_modified)}`,
      r.files_read && r.files_read !== '[]' && `Files read:\n${listField(r.files_read)}`].filter(Boolean).join('\n');
  }).join('\n\n');
}

export function contextFor(db, project, settings) {
  const sums = db.prepare(`SELECT id, request, completed, next_steps, created_at FROM summaries
    WHERE project = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`).all(project, settings.contextSummaries);
  const obs = db.prepare(`SELECT id, type, title, narrative, created_at FROM observations
    WHERE project = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`).all(project, settings.contextObservations);
  if (!sums.length && !obs.length) {
    return `# claude-open-mem\nNo memory yet for project "${project}". It builds up as you work.`;
  }
  const lines = [`# claude-open-mem — memory for project "${project}"`];
  if (sums.length) {
    lines.push('', '## Recent sessions');
    for (const s of sums) {
      lines.push(`- S${s.id} ${day(s.created_at)}: ${clip(s.request, 160)}${s.completed ? ` → ${clip(s.completed, 200)}` : ''}`);
    }
    if (sums[0].next_steps) lines.push(`  Last next steps: ${clip(sums[0].next_steps, 300)}`);
  }
  if (obs.length) {
    lines.push('', '## Recent observations (id · date · type · title)');
    for (const o of obs) lines.push(`- ${o.id} · ${day(o.created_at)} · ${o.type || '-'} · ${clip(o.title || o.narrative, 140)}`);
  }
  lines.push('', 'Details: open-mem MCP tools — search(query) → timeline(anchor) → get_observations(ids). Only fetch what the task needs.');
  return lines.join('\n');
}

// Read models for the web viewer. Everything returns plain JSON-safe objects. Lists are paged:
// { rows, total, page, pageSize } with 1-based pages.
import { deviceName } from './config.mjs';
import { getItem, listItems } from './items.mjs';
import { queueState } from './queue.mjs';
import { clientStatuses } from './sync.mjs';
import { ftsQuery, getByRefs, lessons, notesReview, parseRef, searchCount, stats } from './store.mjs';
import { hybridSearch } from './semantic.mjs';

const DAY = 24 * 3600 * 1000;
const OPEN_STATUSES = "('todo', 'doing', 'blocked', 'active')";
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

export function paging({ page, pageSize } = {}, def = 50, max = 200) {
  const size = Math.min(Math.max(Math.floor(Number(pageSize)) || def, 1), max);
  const p = Math.max(Math.floor(Number(page)) || 1, 1);
  return { page: p, pageSize: size, offset: (p - 1) * size };
}

// Records per day for the last `days` days, optionally for one project.
function activity(db, { project, days = 372 } = {}) {
  const since = Date.now() - days * DAY;
  const p = project ? ' AND project = ? COLLATE NOCASE' : '';
  const args = project ? [since, project] : [since];
  const rows = db.prepare(`SELECT d, sum(n) n FROM (
      SELECT date(created_at / 1000, 'unixepoch') d, count(*) n FROM observations WHERE created_at >= ?${p} GROUP BY d
      UNION ALL
      SELECT date(created_at / 1000, 'unixepoch') d, count(*) n FROM summaries WHERE created_at >= ?${p} GROUP BY d
    ) GROUP BY d ORDER BY d`).all(...args, ...args);
  return rows.map((r) => ({ day: r.d, n: r.n }));
}

// Queues that wait or work: this machine's, and those the clients of a shared server report. A queue that waits shows
// why, so a delay in the activity chart does not read as missing work.
function queues(db, settings) {
  const own = { device: deviceName(settings), ...queueState(db) };
  return [own, ...clientStatuses(db).filter((c) => c.device !== own.device)].filter((q) => q.pending || q.pause || q.down);
}

export function overview(db, settings = {}) {
  const { mode = 'local' } = settings;
  const s = stats(db);
  if (mode !== 'remote') s.unsynced = 0; // only meaningful on a client pushing to a server
  const tasks = db.prepare(`SELECT status, count(*) n FROM items WHERE kind = 'task' GROUP BY status`).all();
  const doneWeek = db.prepare(`SELECT count(*) n FROM items WHERE kind = 'task' AND status = 'done' AND completed_at >= ?`).get(Date.now() - 7 * DAY).n;
  const devices = db.prepare(`SELECT device, count(*) n, max(created_at) last FROM observations WHERE device IS NOT NULL
    GROUP BY device ORDER BY last DESC`).all();
  const all = projects(db);
  s.sessions = sessionIndex(db).length;
  s.projects = all.length;
  return {
    stats: s, tasks, doneWeek, devices, activity: activity(db), queues: queues(db, settings), recentSessions: sessions(db, { pageSize: 6 }).rows,
    openTasks: listItems(db, { kind: 'task', open: true, limit: 8 }), projects: all.slice(0, 8),
  };
}

export function projects(db) {
  const rows = db.prepare(`SELECT project, sum(obs) obs, sum(sums) sums, max(last) last, min(first) first FROM (
      SELECT project, count(*) obs, 0 sums, max(created_at) last, min(created_at) first FROM observations GROUP BY project COLLATE NOCASE
      UNION ALL
      SELECT project, 0, count(*), max(created_at), min(created_at) FROM summaries GROUP BY project COLLATE NOCASE
      UNION ALL
      SELECT project, 0, 0, max(updated_at), min(created_at) FROM items WHERE project IS NOT NULL GROUP BY project COLLATE NOCASE
    ) WHERE project IS NOT NULL GROUP BY project COLLATE NOCASE ORDER BY last DESC`).all();
  const items = db.prepare(`SELECT project, sum(kind = 'note') notes, sum(kind = 'task' AND status IN ('todo', 'doing', 'blocked')) open,
      sum(kind = 'task' AND status = 'done') done FROM items GROUP BY project COLLATE NOCASE`).all();
  const byName = new Map(items.map((i) => [String(i.project).toLowerCase(), i]));
  const sessionsBy = new Map();
  for (const s of sessionIndex(db)) {
    for (const p of s.projects) {
      const key = String(p).toLowerCase();
      sessionsBy.set(key, (sessionsBy.get(key) || 0) + 1);
    }
  }
  return rows.map((r) => {
    const key = String(r.project).toLowerCase();
    const i = byName.get(key) || {};
    return { ...r, sessions: sessionsBy.get(key) || 0, notes: i.notes || 0, openTasks: i.open || 0, doneTasks: i.done || 0 };
  });
}

// Values for the filter menus: projects by last activity, machines, observation types.
export function facets(db) {
  return {
    projects: projects(db).map((p) => p.project),
    devices: db.prepare(`SELECT device FROM observations WHERE device IS NOT NULL GROUP BY device
      UNION SELECT device FROM summaries WHERE device IS NOT NULL UNION SELECT device FROM sessions WHERE device IS NOT NULL`).all()
      .map((r) => r.device).sort(),
    types: observationTypes(db),
  };
}

// A full scan of observations: computed again only when new ones arrive.
const typesCache = new WeakMap();
function observationTypes(db) {
  const key = db.prepare('SELECT max(id) m FROM observations').get().m;
  const hit = typesCache.get(db);
  if (hit?.key === key) return hit.types;
  const types = db.prepare('SELECT type, count(*) n FROM observations WHERE type IS NOT NULL GROUP BY type ORDER BY n DESC').all().map((r) => r.type);
  typesCache.set(db, { key, types });
  return types;
}

export function projectDetail(db, name) {
  const summary = projects(db).find((p) => same(p.project, name));
  if (!summary) return null;
  const project = summary.project;
  const brief = db.prepare('SELECT body, generated_at, model FROM briefs WHERE project = ?').get(project) ?? null;
  const recent = db.prepare(`SELECT id, request, completed, next_steps, created_at, device, git_branch, session_id FROM summaries
    WHERE project = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 10`).all(project);
  const types = db.prepare(`SELECT type, count(*) n FROM observations WHERE project = ? COLLATE NOCASE GROUP BY type ORDER BY n DESC`).all(project);
  const branches = db.prepare(`SELECT git_branch branch, count(*) n, max(created_at) last FROM observations
    WHERE project = ? COLLATE NOCASE AND git_branch IS NOT NULL GROUP BY git_branch ORDER BY last DESC LIMIT 10`).all(project);
  const files = new Map();
  for (const r of db.prepare(`SELECT files_modified FROM observations WHERE project = ? COLLATE NOCASE
      AND files_modified IS NOT NULL AND files_modified != '[]' ORDER BY created_at DESC LIMIT 1500`).iterate(project)) {
    try { for (const f of JSON.parse(r.files_modified)) files.set(f, (files.get(f) || 0) + 1); } catch { /* skip */ }
  }
  return {
    ...summary, brief, recent, types, branches,
    files: [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([file, n]) => ({ file, n })),
    tasks: listItems(db, { kind: 'task', project, limit: 200 }),
    notes: listItems(db, { kind: 'note', project, limit: 100 }),
    activity: activity(db, { project, days: 365 }),
    review: notesReview(db, project),
    lessons: lessons(db, project),
  };
}

// --- timeline -------------------------------------------------------------------------------------------
// One newest-first stream of observations, session summaries and note/task events. A light query pages over
// (kind, id, time) only; the page's rows are then read in full.
const FEED = {
  obs: { from: 'observations o', time: 'o.created_at', id: 'o.id', project: 'o.project', device: 'o.device',
    rows: `SELECT 'obs' kind, id, project, type, COALESCE(title, substr(narrative, 1, 120)) title, subtitle, created_at at, device,
      git_branch, tool, session_id FROM observations WHERE id IN` },
  sum: { from: 'summaries s', time: 's.created_at', id: 's.id', project: 's.project', device: 's.device',
    rows: `SELECT 'sum' kind, id, project, 'summary' type, request title, completed subtitle, created_at at, device, git_branch,
      session_id FROM summaries WHERE id IN` },
  event: { from: 'item_events e JOIN items i ON i.id = e.item_id', time: 'e.at', id: 'e.id', project: 'i.project', device: 'COALESCE(e.device, i.device)',
    rows: `SELECT 'event' kind, e.id event_id, i.id, i.project, i.kind type, i.title, e.event, e.to_status, e.detail subtitle, e.at at,
      COALESCE(e.device, i.device) device, i.status FROM item_events e JOIN items i ON i.id = e.item_id WHERE e.id IN` },
};

export function feed(db, { project, kinds = 'obs,sum,event', device, before, page, pageSize } = {}) {
  const p = paging({ page, pageSize }, 50, 200);
  const want = String(kinds).split(',').filter((k) => FEED[k]);
  const cut = Number(before) || Date.now() + DAY;
  const parts = want.map((k) => {
    const f = FEED[k];
    const where = [`${f.time} < ?`];
    const args = [cut];
    if (project) { where.push(`${f.project} = ? COLLATE NOCASE`); args.push(project); }
    if (device) { where.push(`${f.device} = ?`); args.push(device); }
    return { k, f, where: where.join(' AND '), args };
  });
  if (!parts.length) return { rows: [], total: 0, page: p.page, pageSize: p.pageSize };
  const total = parts.reduce((n, x) => n + db.prepare(`SELECT count(*) n FROM ${x.f.from} WHERE ${x.where}`).get(...x.args).n, 0);
  const page1 = db.prepare(`SELECT kind, id, at FROM (${parts.map((x) => `SELECT '${x.k}' kind, ${x.f.id} id, ${x.f.time} at FROM ${x.f.from} WHERE ${x.where}`).join(' UNION ALL ')})
    ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`).all(...parts.flatMap((x) => x.args), p.pageSize, p.offset);
  const full = new Map();
  for (const k of want) {
    const ids = page1.filter((r) => r.kind === k).map((r) => r.id);
    if (!ids.length) continue;
    for (const row of db.prepare(`${FEED[k].rows} (${ids.map(() => '?').join(',')})`).all(...ids)) full.set(`${k}:${row.event_id ?? row.id}`, row);
  }
  return { rows: page1.map((r) => full.get(`${r.kind}:${r.id}`)).filter(Boolean), total, page: p.page, pageSize: p.pageSize };
}

// --- sessions ---------------------------------------------------------------------------------------------
// Sessions are built from the records themselves (imported claude-mem sessions have no row in `sessions`), merged with
// the native rows. Cached until a record or session is added.
const sessionCache = new WeakMap();
function sessionIndex(db) {
  const key = JSON.stringify(db.prepare(`SELECT (SELECT max(id) FROM observations) o, (SELECT max(id) FROM summaries) s,
    (SELECT max(id) FROM prompts) p, (SELECT count(*) FROM sessions) n, (SELECT max(last_seen_at) FROM sessions) l`).get());
  const hit = sessionCache.get(db);
  if (hit?.key === key) return hit.list;
  const byId = new Map();
  // One row per session and project: a session that touched several projects counts for each of them; its own
  // project is the one with the most records.
  for (const r of db.prepare(`SELECT session_id, project, count(*) n, min(at) started_at, max(at) last_at, sum(k = 'o') obs, sum(k = 's') sums,
      sum(k = 'p') prompts, max(device) device, max(git_branch) git_branch, max(cwd) cwd FROM (
        SELECT session_id, created_at at, 'o' k, project, device, git_branch, cwd FROM observations WHERE session_id IS NOT NULL
        UNION ALL SELECT session_id, created_at, 's', project, device, git_branch, cwd FROM summaries WHERE session_id IS NOT NULL
        UNION ALL SELECT session_id, created_at, 'p', project, device, NULL, cwd FROM prompts WHERE session_id IS NOT NULL
      ) GROUP BY session_id, project COLLATE NOCASE`).iterate()) {
    const s = byId.get(r.session_id);
    if (!s) { byId.set(r.session_id, { ...r, projects: r.project ? [r.project] : [] }); continue; }
    if (r.project) s.projects.push(r.project);
    if (r.project && (r.n > s.n || !s.project)) { s.project = r.project; s.n = r.n; }
    for (const k of ['obs', 'sums', 'prompts']) s[k] += r[k];
    s.started_at = Math.min(s.started_at, r.started_at);
    s.last_at = Math.max(s.last_at, r.last_at);
    for (const k of ['device', 'git_branch', 'cwd']) s[k] ||= r[k];
  }
  for (const s of db.prepare('SELECT session_id, project, cwd, device, git_branch, started_at, last_seen_at, prompt_counter FROM sessions').iterate()) {
    const r = byId.get(s.session_id) || { session_id: s.session_id, obs: 0, sums: 0, prompts: 0, projects: [] };
    byId.set(s.session_id, {
      ...r, project: s.project || r.project, cwd: s.cwd || r.cwd, device: s.device || r.device, git_branch: s.git_branch || r.git_branch,
      started_at: Math.min(s.started_at ?? Infinity, r.started_at ?? Infinity), last_at: Math.max(s.last_seen_at || 0, r.last_at || 0),
      prompts: Math.max(r.prompts, s.prompt_counter || 0),
      projects: s.project && !r.projects.some((p) => same(p, s.project)) ? [...r.projects, s.project] : r.projects,
    });
  }
  for (const s of byId.values()) delete s.n;
  const list = [...byId.values()].filter((r) => Number.isFinite(r.started_at)).sort((a, b) => b.started_at - a.started_at);
  sessionCache.set(db, { key, list });
  return list;
}

const likeArg = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function sessions(db, { project, device, q, page, pageSize } = {}) {
  const p = paging({ page, pageSize }, 30, 100);
  let list = sessionIndex(db);
  if (project) list = list.filter((r) => r.projects.some((p) => same(p, project)));
  if (device) list = list.filter((r) => r.device === device);
  if (q && String(q).trim()) {
    const like = likeArg(String(q).trim());
    const ids = new Set(db.prepare(`SELECT session_id FROM prompts WHERE text LIKE ? ESCAPE '\\'
      UNION SELECT session_id FROM summaries WHERE request LIKE ? ESCAPE '\\' OR completed LIKE ? ESCAPE '\\'`).all(like, like, like).map((r) => r.session_id));
    list = list.filter((r) => ids.has(r.session_id));
  }
  const firstPrompt = db.prepare('SELECT text FROM prompts WHERE session_id = ? ORDER BY prompt_number, id LIMIT 1');
  const firstRequest = db.prepare('SELECT request FROM summaries WHERE session_id = ? ORDER BY prompt_number, created_at LIMIT 1');
  const rows = list.slice(p.offset, p.offset + p.pageSize).map((r) => ({
    ...r,
    first_prompt: firstPrompt.get(r.session_id)?.text?.slice(0, 300) ?? null,
    first_request: firstRequest.get(r.session_id)?.request ?? null,
  }));
  return { rows, total: list.length, page: p.page, pageSize: p.pageSize };
}

export function sessionDetail(db, id) {
  const native = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id);
  const indexed = sessionIndex(db).find((r) => r.session_id === id);
  if (!native && !indexed) return null;
  const session = { ...(native || {}), ...(indexed || {}) };
  delete session.injected;
  return {
    session,
    prompts: db.prepare('SELECT id, prompt_number, text, created_at FROM prompts WHERE session_id = ? ORDER BY prompt_number, id').all(id),
    observations: db.prepare(`SELECT id, prompt_number, type, title, subtitle, tool, files_modified, created_at FROM observations
      WHERE session_id = ? ORDER BY created_at, id`).all(id),
    summaries: db.prepare(`SELECT id, prompt_number, request, completed, next_steps, learned, created_at FROM summaries
      WHERE session_id = ? ORDER BY prompt_number`).all(id),
  };
}

// --- notes and tasks ----------------------------------------------------------------------------------------
export function itemsPage(db, { kind, project, status, q, page, pageSize } = {}) {
  const p = paging({ page, pageSize }, 30, 200);
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (project) { where.push('project = ? COLLATE NOCASE'); args.push(project); }
  if (status === 'open') where.push(`status IN ${OPEN_STATUSES}`);
  else if (status) { where.push('status = ?'); args.push(status); }
  if (q && String(q).trim()) {
    const match = ftsQuery(q);
    if (!match) return { rows: [], total: 0, page: p.page, pageSize: p.pageSize };
    where.push('id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)');
    args.push(match);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT count(*) n FROM items ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT id, kind, project, directory, title, body, status, priority, tags, due_at, created_at, updated_at, completed_at, device
    FROM items ${w}
    ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'blocked' THEN 1 WHEN 'todo' THEN 2 WHEN 'active' THEN 2 ELSE 3 END, priority, updated_at DESC
    LIMIT ? OFFSET ?`).all(...args, p.pageSize, p.offset);
  return { rows, total, page: p.page, pageSize: p.pageSize };
}

// --- search ------------------------------------------------------------------------------------------------
const SNIPPET = {
  obs: (db) => db.prepare(`SELECT COALESCE(NULLIF(subtitle, ''), substr(narrative, 1, 300)) snippet, device, git_branch, session_id FROM observations WHERE id = ?`),
  sum: (db) => db.prepare(`SELECT substr(COALESCE(NULLIF(completed, ''), learned, investigated), 1, 300) snippet, device, git_branch, session_id FROM summaries WHERE id = ?`),
  item: (db) => db.prepare(`SELECT substr(body, 1, 300) snippet, device, NULL git_branch, session_id, status FROM items WHERE id = ?`),
};

// The search Claude uses (full-text plus meaning), paged, with a short excerpt per result.
export async function find(db, { query, project, kind, type, dateStart, dateEnd, page, pageSize } = {}, settings = {}) {
  const p = paging({ page, pageSize }, 25, 100);
  const o = { query, project, kind, type, dateStart, dateEnd, limit: p.pageSize, offset: p.offset };
  const rows = await hybridSearch(db, o, settings);
  const stmts = {};
  const out = rows.map((r) => ({ ...r, ...((stmts[r.kind] ??= SNIPPET[r.kind](db)).get(r.id) || {}) }));
  return { rows: out, total: Math.max(searchCount(db, o), p.offset + out.length), page: p.page, pageSize: p.pageSize };
}

export function record(db, ref) {
  const r = parseRef(ref);
  if (!r) return null;
  if (r.kind === 'item') {
    const item = getItem(db, r.id);
    return item ? { ...item, item_kind: item.kind, kind: 'item' } : null;
  }
  return getByRefs(db, [ref])[0] ?? null;
}

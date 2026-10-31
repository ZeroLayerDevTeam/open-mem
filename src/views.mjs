// Read models for the web viewer. Everything returns plain JSON-safe objects.
import { getItem, listItems } from './items.mjs';
import { getByRefs, parseRef, stats } from './store.mjs';

const DAY = 24 * 3600 * 1000;

// Records per day for the last `days` days, optionally for one project.
function activity(db, { project, days = 120 } = {}) {
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

export function overview(db, { mode = 'local' } = {}) {
  const s = stats(db);
  if (mode !== 'remote') s.unsynced = 0; // only meaningful on a client pushing to a server
  const tasks = db.prepare(`SELECT status, count(*) n FROM items WHERE kind = 'task' GROUP BY status`).all();
  const doneWeek = db.prepare(`SELECT count(*) n FROM items WHERE kind = 'task' AND status = 'done' AND completed_at >= ?`).get(Date.now() - 7 * DAY).n;
  const devices = db.prepare(`SELECT device, count(*) n, max(created_at) last FROM observations WHERE device IS NOT NULL
    GROUP BY device ORDER BY last DESC`).all();
  const recentSessions = sessions(db, { limit: 6 });
  const openTasks = listItems(db, { kind: 'task', open: true, limit: 8 });
  return { stats: s, tasks, doneWeek, devices, activity: activity(db), recentSessions, openTasks, projects: projects(db).slice(0, 8) };
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
  return rows.map((r) => {
    const i = byName.get(String(r.project).toLowerCase()) || {};
    return { ...r, notes: i.notes || 0, openTasks: i.open || 0, doneTasks: i.done || 0 };
  });
}

export function projectDetail(db, name) {
  const summary = projects(db).find((p) => p.project.toLowerCase() === String(name).toLowerCase());
  if (!summary) return null;
  const project = summary.project;
  const brief = db.prepare('SELECT body, generated_at, model FROM briefs WHERE project = ?').get(project) ?? null;
  const recent = db.prepare(`SELECT id, request, completed, next_steps, created_at, device, git_branch FROM summaries
    WHERE project = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 12`).all(project);
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
    files: [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([file, n]) => ({ file, n })),
    tasks: listItems(db, { kind: 'task', project, limit: 200 }),
    notes: listItems(db, { kind: 'note', project, limit: 100 }),
    activity: activity(db, { project, days: 365 }),
  };
}

// Unified, newest-first stream of observations, summaries and note/task events. Cursor = `before` (ms).
export function feed(db, { project, kinds = 'obs,sum,event', device, before, limit = 60 } = {}) {
  const want = new Set(String(kinds).split(','));
  const lim = Math.min(Number(limit) || 60, 200);
  const cut = Number(before) || Date.now() + DAY;
  const filters = (alias, timeCol) => {
    const w = [`${alias}.${timeCol} < ?`];
    const a = [cut];
    if (project) { w.push(`${alias}.project = ? COLLATE NOCASE`); a.push(project); }
    if (device) { w.push(`${alias}.device = ?`); a.push(device); }
    return { where: w.join(' AND '), args: a };
  };
  const out = [];
  if (want.has('obs')) {
    const f = filters('o', 'created_at');
    out.push(...db.prepare(`SELECT 'obs' kind, o.id, o.project, o.type, o.title, o.subtitle, o.created_at at, o.device, o.git_branch, o.tool,
        o.files_modified, o.session_id FROM observations o WHERE ${f.where} ORDER BY o.created_at DESC LIMIT ?`).all(...f.args, lim));
  }
  if (want.has('sum')) {
    const f = filters('s', 'created_at');
    out.push(...db.prepare(`SELECT 'sum' kind, s.id, s.project, 'summary' type, s.request title, s.completed subtitle, s.created_at at,
        s.device, s.git_branch, s.session_id FROM summaries s WHERE ${f.where} ORDER BY s.created_at DESC LIMIT ?`).all(...f.args, lim));
  }
  if (want.has('event')) {
    const f = filters('i', 'created_at');
    const where = f.where.replace('i.created_at < ?', 'e.at < ?');
    out.push(...db.prepare(`SELECT 'event' kind, i.id, i.project, i.kind type, i.title, e.event || COALESCE(' → ' || e.to_status, '') subtitle,
        e.at at, COALESCE(e.device, i.device) device, NULL git_branch, i.status, e.detail FROM item_events e JOIN items i ON i.id = e.item_id
      WHERE ${where} ORDER BY e.at DESC LIMIT ?`).all(...f.args, lim));
  }
  out.sort((a, b) => b.at - a.at);
  const page = out.slice(0, lim);
  return { rows: page, next: page.length === lim ? page[page.length - 1].at : null };
}

export function sessions(db, { project, limit = 40, before } = {}) {
  const w = ['s.started_at < ?'];
  const a = [Number(before) || Date.now() + DAY];
  if (project) { w.push('s.project = ? COLLATE NOCASE'); a.push(project); }
  return db.prepare(`SELECT s.session_id, s.project, s.cwd, s.device, s.git_branch, s.started_at, s.last_seen_at, s.prompt_counter,
      (SELECT count(*) FROM observations o WHERE o.session_id = s.session_id) obs,
      (SELECT request FROM summaries x WHERE x.session_id = s.session_id ORDER BY x.prompt_number LIMIT 1) first_request,
      (SELECT text FROM prompts p WHERE p.session_id = s.session_id ORDER BY p.prompt_number LIMIT 1) first_prompt
    FROM sessions s WHERE ${w.join(' AND ')} ORDER BY s.started_at DESC LIMIT ?`).all(...a, Math.min(Number(limit) || 40, 200))
    .map((r) => ({ ...r, first_prompt: r.first_prompt ? String(r.first_prompt).slice(0, 300) : null }));
}

export function sessionDetail(db, id) {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id);
  if (!session) return null;
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

export function record(db, ref) {
  const r = parseRef(ref);
  if (!r) return null;
  if (r.kind === 'item') {
    const item = getItem(db, r.id);
    return item ? { ...item, item_kind: item.kind, kind: 'item' } : null;
  }
  return getByRefs(db, [ref])[0] ?? null;
}

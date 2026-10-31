// Notes and tasks: records Claude and the user create on purpose, with a status history.
import { transaction } from './db.mjs';
import { asText } from './store.mjs';

export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done', 'cancelled'];
export const NOTE_STATUSES = ['active', 'archived'];
const OPEN = new Set(['todo', 'doing', 'blocked']);

function cleanTags(tags) {
  if (tags == null) return null;
  const list = (Array.isArray(tags) ? tags : String(tags).split(','))
    .map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
  return list.length ? JSON.stringify([...new Set(list)]) : null;
}

function toTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v);
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${s}`);
  return t;
}

function checkStatus(kind, status) {
  const allowed = kind === 'task' ? TASK_STATUSES : NOTE_STATUSES;
  if (!allowed.includes(status)) throw new Error(`Invalid ${kind} status "${status}". Use: ${allowed.join(', ')}`);
}

const priorityOf = (p) => {
  const n = Number(p ?? 2);
  if (!Number.isInteger(n) || n < 1 || n > 3) throw new Error('priority must be 1 (high), 2 (normal) or 3 (low)');
  return n;
};

function event(db, itemId, e) {
  db.prepare('INSERT INTO item_events (item_id, at, event, from_status, to_status, detail, device) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(itemId, e.at ?? Date.now(), e.event, e.from ?? null, e.to ?? null, asText(e.detail), e.device ?? null);
}

export function addItem(db, input) {
  const kind = input.kind === 'task' ? 'task' : 'note';
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('title is required');
  const status = input.status || (kind === 'task' ? 'todo' : 'active');
  checkStatus(kind, status);
  const now = input.created_at ?? Date.now();
  return transaction(db, () => {
    const id = Number(db.prepare(`INSERT INTO items (kind, project, directory, title, body, status, priority, tags, due_at,
        created_at, updated_at, completed_at, session_id, device, metadata, source, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      kind, input.project || null, input.directory || null, asText(title).slice(0, 300), asText(input.body),
      status, priorityOf(input.priority), cleanTags(input.tags), toTime(input.due), now, input.updated_at ?? now,
      kind === 'task' && !OPEN.has(status) ? now : null, input.session_id || null, input.device || null,
      asText(input.metadata), input.source || 'native', input.source_id || null,
    ).lastInsertRowid);
    event(db, id, { event: 'created', to: status, device: input.device, at: now });
    return id;
  });
}

export function getItem(db, id) {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id));
  if (!row) return null;
  row.events = db.prepare('SELECT at, event, from_status, to_status, detail, device FROM item_events WHERE item_id = ? ORDER BY at, id').all(row.id);
  return row;
}

// patch: title, body, status, priority, tags, due, project, directory, comment
export function updateItem(db, id, patch, { device } = {}) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id));
  if (!item) throw new Error(`No note or task with id I${id}`);
  const sets = {};
  const edited = [];
  for (const f of ['title', 'body', 'project', 'directory']) {
    if (patch[f] !== undefined && (patch[f] || null) !== item[f]) { sets[f] = f === 'title' || f === 'body' ? asText(patch[f]) : patch[f] || null; edited.push(f); }
  }
  if (patch.priority !== undefined) { sets.priority = priorityOf(patch.priority); if (sets.priority !== item.priority) edited.push('priority'); }
  if (patch.tags !== undefined) { sets.tags = cleanTags(patch.tags); edited.push('tags'); }
  if (patch.due !== undefined) { sets.due_at = toTime(patch.due); edited.push('due'); }
  if (sets.title === null || sets.title === '') throw new Error('title cannot be empty');
  let statusChange = null;
  if (patch.status && patch.status !== item.status) {
    checkStatus(item.kind, patch.status);
    sets.status = patch.status;
    statusChange = { from: item.status, to: patch.status };
    if (item.kind === 'task') sets.completed_at = OPEN.has(patch.status) ? null : Date.now();
  }
  const comment = patch.comment ? String(patch.comment).trim() : '';
  if (!Object.keys(sets).length && !comment) return getItem(db, id);
  const now = Date.now();
  transaction(db, () => {
    sets.updated_at = now;
    sets.synced_at = null;
    const cols = Object.keys(sets);
    db.prepare(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => sets[c]), item.id);
    if (statusChange) event(db, item.id, { event: 'status', ...statusChange, detail: comment || null, device, at: now });
    else if (comment) event(db, item.id, { event: 'comment', detail: comment, device, at: now });
    if (edited.length) event(db, item.id, { event: 'edited', detail: edited.join(', '), device, at: now });
  });
  return getItem(db, id);
}

export function deleteItem(db, id) {
  return Number(db.prepare('DELETE FROM items WHERE id = ?').run(Number(id)).changes) > 0;
}

export function listItems(db, { kind, project, directory, status, open, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (project) { where.push('project = ? COLLATE NOCASE'); params.push(project); }
  if (directory) { where.push('(directory = ? OR directory LIKE ?)'); params.push(directory, `${directory.replace(/[\\/]+$/, '')}%`); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (open) where.push("status IN ('todo', 'doing', 'blocked', 'active')");
  params.push(Math.min(Number(limit) || 100, 500), Math.max(Number(offset) || 0, 0));
  return db.prepare(`SELECT id, kind, project, directory, title, body, status, priority, tags, due_at, created_at, updated_at, completed_at, device
    FROM items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'blocked' THEN 1 WHEN 'todo' THEN 2 WHEN 'active' THEN 2 ELSE 3 END,
      priority, updated_at DESC LIMIT ? OFFSET ?`).all(...params);
}

export function formatItems(rows) {
  if (!rows.length) return 'No notes or tasks.';
  const day = (ms) => new Date(Number(ms)).toISOString().slice(0, 10);
  return rows.map((r) => `I${r.id} · ${r.kind} [${r.status}]${r.priority === 1 ? ' !' : ''} · ${r.project || '-'} · ${r.title}`
    + `${r.due_at ? ` · due ${day(r.due_at)}` : ''} · updated ${day(r.updated_at)}`).join('\n');
}

// Sync helper: replace an item (by source/source_id) and its history with an incoming copy.
export function upsertSyncedItem(db, row) {
  return transaction(db, () => {
    const existing = db.prepare('SELECT id, updated_at FROM items WHERE source = ? AND source_id = ?').get(row.source, row.source_id);
    if (existing && existing.updated_at >= row.updated_at) return existing.id;
    if (existing) db.prepare('DELETE FROM items WHERE id = ?').run(existing.id);
    const id = Number(db.prepare(`INSERT INTO items (kind, project, directory, title, body, status, priority, tags, due_at,
        created_at, updated_at, completed_at, session_id, device, metadata, source, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.kind === 'task' ? 'task' : 'note', row.project ?? null, row.directory ?? null, asText(row.title) || '(untitled)', asText(row.body),
      row.status ?? null, Number(row.priority) || 2, row.tags ?? null, row.due_at ?? null, Number(row.created_at) || Date.now(),
      Number(row.updated_at) || Date.now(), row.completed_at ?? null, row.session_id ?? null, row.device ?? null, asText(row.metadata),
      row.source, row.source_id,
    ).lastInsertRowid);
    for (const e of row.events || []) event(db, id, { event: e.event, from: e.from_status, to: e.to_status, detail: e.detail, device: e.device, at: e.at });
    return id;
  });
}

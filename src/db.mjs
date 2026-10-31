// SQLite storage (node:sqlite, FTS5). One file: <dataDir>/open-mem.db
import { DatabaseSync } from 'node:sqlite';
import { dataPath, ensureDataDir } from './config.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project TEXT,
  cwd TEXT,
  prompt_counter INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  source TEXT NOT NULL DEFAULT 'native'
);

CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  project TEXT,
  prompt_number INTEGER,
  text TEXT,
  created_at INTEGER,
  source TEXT NOT NULL DEFAULT 'native',
  source_id TEXT,
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS prompts_session ON prompts (session_id, prompt_number);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  project TEXT,
  prompt_number INTEGER,
  type TEXT,
  title TEXT,
  subtitle TEXT,
  narrative TEXT,
  facts TEXT,
  concepts TEXT,
  files_read TEXT,
  files_modified TEXT,
  tool TEXT,
  created_at INTEGER,
  source TEXT NOT NULL DEFAULT 'native',
  source_id TEXT,
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS obs_project_time ON observations (project COLLATE NOCASE, created_at);
CREATE INDEX IF NOT EXISTS obs_time ON observations (created_at);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  project TEXT,
  prompt_number INTEGER,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  notes TEXT,
  created_at INTEGER,
  source TEXT NOT NULL DEFAULT 'native',
  source_id TEXT,
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS sum_project_time ON summaries (project COLLATE NOCASE, created_at);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  session_id TEXT,
  project TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS queue_status ON queue (status, id);

CREATE VIRTUAL TABLE IF NOT EXISTS obs_fts USING fts5(
  title, subtitle, narrative, facts, concepts,
  content='observations', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO obs_fts (rowid, title, subtitle, narrative, facts, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts);
END;
CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO obs_fts (obs_fts, rowid, title, subtitle, narrative, facts, concepts)
  VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts);
END;
CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
  INSERT INTO obs_fts (obs_fts, rowid, title, subtitle, narrative, facts, concepts)
  VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts);
  INSERT INTO obs_fts (rowid, title, subtitle, narrative, facts, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS sum_fts USING fts5(
  request, investigated, learned, completed, next_steps, notes,
  content='summaries', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS sum_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO sum_fts (rowid, request, investigated, learned, completed, next_steps, notes)
  VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS sum_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO sum_fts (sum_fts, rowid, request, investigated, learned, completed, next_steps, notes)
  VALUES ('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
END;
CREATE TRIGGER IF NOT EXISTS sum_au AFTER UPDATE ON summaries BEGIN
  INSERT INTO sum_fts (sum_fts, rowid, request, investigated, learned, completed, next_steps, notes)
  VALUES ('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
  INSERT INTO sum_fts (rowid, request, investigated, learned, completed, next_steps, notes)
  VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
END;
`;

export function openDb(file = dataPath('open-mem.db')) {
  ensureDataDir();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

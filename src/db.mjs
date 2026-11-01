// SQLite storage (node:sqlite, FTS5). One file: <dataDir>/open-mem.db
import { DatabaseSync } from 'node:sqlite';
import { dataPath, ensureDataDir } from './config.mjs';

export const SCHEMA_VERSION = 5;

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
CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE OF title, subtitle, narrative, facts, concepts ON observations BEGIN
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
CREATE TRIGGER IF NOT EXISTS sum_au AFTER UPDATE OF request, investigated, learned, completed, next_steps, notes ON summaries BEGIN
  INSERT INTO sum_fts (sum_fts, rowid, request, investigated, learned, completed, next_steps, notes)
  VALUES ('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
  INSERT INTO sum_fts (rowid, request, investigated, learned, completed, next_steps, notes)
  VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
END;
`;

// v2: notes/tasks, their event log, project briefs, devices, web sessions.
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'task')),
  project TEXT,
  directory TEXT,
  title TEXT NOT NULL,
  body TEXT,
  status TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  tags TEXT,
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  session_id TEXT,
  device TEXT,
  metadata TEXT,
  source TEXT NOT NULL DEFAULT 'native',
  source_id TEXT,
  synced_at INTEGER,
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS items_project ON items (project COLLATE NOCASE, kind, status);
CREATE INDEX IF NOT EXISTS items_updated ON items (updated_at);

CREATE TABLE IF NOT EXISTS item_events (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  event TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail TEXT,
  device TEXT
);
CREATE INDEX IF NOT EXISTS item_events_item ON item_events (item_id, at);
CREATE INDEX IF NOT EXISTS item_events_at ON item_events (at);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, body, tags, content='items', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE OF title, body, tags ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO items_fts (rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;

CREATE TABLE IF NOT EXISTS briefs (
  project TEXT PRIMARY KEY COLLATE NOCASE,
  body TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0,
  model TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

// v3: embedding vectors for semantic search, keyed by ref ("123", "S5", "I7"). A record whose text changes or that is
// deleted loses its vector, so the next drain embeds it again.
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS embeddings (
  ref TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  vec BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS emb_obs_ad AFTER DELETE ON observations BEGIN DELETE FROM embeddings WHERE ref = CAST(old.id AS TEXT); END;
CREATE TRIGGER IF NOT EXISTS emb_obs_au AFTER UPDATE OF title, subtitle, narrative ON observations BEGIN DELETE FROM embeddings WHERE ref = CAST(old.id AS TEXT); END;
CREATE TRIGGER IF NOT EXISTS emb_sum_ad AFTER DELETE ON summaries BEGIN DELETE FROM embeddings WHERE ref = 'S' || old.id; END;
CREATE TRIGGER IF NOT EXISTS emb_sum_au AFTER UPDATE OF request, learned, completed ON summaries BEGIN DELETE FROM embeddings WHERE ref = 'S' || old.id; END;
CREATE TRIGGER IF NOT EXISTS emb_items_ad AFTER DELETE ON items BEGIN DELETE FROM embeddings WHERE ref = 'I' || old.id; END;
CREATE TRIGGER IF NOT EXISTS emb_items_au AFTER UPDATE OF title, body ON items BEGIN DELETE FROM embeddings WHERE ref = 'I' || old.id; END;
`;

// v4: indexes for the web viewer: sessions built from records (imported ones have no sessions row), the paged
// timeline and the machines list. Runs after addMissingColumns (device is a v2 column).
const SCHEMA_V4 = `
CREATE INDEX IF NOT EXISTS obs_session ON observations (session_id, created_at);
CREATE INDEX IF NOT EXISTS sum_session ON summaries (session_id, created_at);
CREATE INDEX IF NOT EXISTS sum_time ON summaries (created_at);
CREATE INDEX IF NOT EXISTS obs_device ON observations (device, created_at);
`;

// v5: one row per LLM call (chat or embedding batch) for the web viewer's LLM page: speed, latency, failures.
// Times in ms, token counts as the provider reports them. Rows older than 30 days are pruned.
const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  task TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  ok INTEGER NOT NULL,
  items INTEGER,
  prompt_tokens INTEGER,
  output_tokens INTEGER,
  load_ms REAL,
  prompt_ms REAL,
  eval_ms REAL,
  total_ms REAL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS llm_calls_at ON llm_calls (at);
`;

// Reconstruction metadata added to every captured record in v2.
const V2_COLUMNS = {
  sessions: ['device TEXT', 'git_branch TEXT', 'git_commit TEXT', 'injected TEXT', 'last_seen_at INTEGER'],
  prompts: ['cwd TEXT', 'device TEXT', 'metadata TEXT', 'synced_at INTEGER'],
  observations: ['cwd TEXT', 'device TEXT', 'git_branch TEXT', 'git_commit TEXT', 'model TEXT', 'metadata TEXT', 'synced_at INTEGER'],
  summaries: ['cwd TEXT', 'device TEXT', 'git_branch TEXT', 'git_commit TEXT', 'files_read TEXT', 'files_modified TEXT',
    'model TEXT', 'metadata TEXT', 'synced_at INTEGER'],
};

function addMissingColumns(db) {
  for (const [table, defs] of Object.entries(V2_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const def of defs) if (!have.has(def.split(' ')[0])) db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
  }
}

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    // v1 update triggers fired on every column (incl. sync bookkeeping): recreate them column-scoped.
    db.exec('DROP TRIGGER IF EXISTS obs_au; DROP TRIGGER IF EXISTS sum_au;');
    db.exec(SCHEMA);
    db.exec(SCHEMA_V2);
    db.exec(SCHEMA_V3);
    addMissingColumns(db);
    db.exec('CREATE INDEX IF NOT EXISTS obs_unsynced ON observations (id) WHERE synced_at IS NULL');
    db.exec('CREATE INDEX IF NOT EXISTS sum_unsynced ON summaries (id) WHERE synced_at IS NULL');
    db.exec('CREATE INDEX IF NOT EXISTS prompts_unsynced ON prompts (id) WHERE synced_at IS NULL');
    db.exec(SCHEMA_V4);
    db.exec(SCHEMA_V5);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function openDb(file = dataPath('open-mem.db')) {
  ensureDataDir();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
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

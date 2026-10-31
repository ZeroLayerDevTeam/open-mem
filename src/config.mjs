// Paths and user settings for claude-open-mem.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.2.3';

export const DEFAULT_SETTINGS = {
  // auto: use a local Ollama if reachable, otherwise store without an LLM.
  // ollama | openai (any OpenAI-compatible endpoint) | none
  provider: 'auto',
  model: '',
  baseUrl: '',
  apiKey: '',
  llmTimeoutMs: 120000,
  // Once an LLM has been seen, a queue item waits this long for it to come back before it is stored
  // without one (the no-LLM path keeps only edits and commands).
  llmWaitHours: 72,
  // Tools whose calls are never recorded.
  skipTools: ['TodoWrite', 'AskUserQuestion', 'ListMcpResourcesTool', 'Skill', 'ToolSearch', 'SlashCommand'],
  maxToolChars: 6000,
  contextObservations: 12,
  contextSummaries: 3,
  contextTasks: 10,
  // Inject memory matching each prompt (FTS only, no LLM).
  recallOnPrompt: true,
  recallLimit: 5,
  // Regenerate a project's brief after this many new records.
  briefEvery: 25,
  excludedProjects: [],
  // Import new rows from an existing claude-mem database at session start.
  autoImportClaudeMem: true,
  // local: this machine's database. remote: a shared open-mem server (see `cli remote connect`).
  mode: 'local',
  serverUrl: '',
  deviceKey: '',
  remoteTimeoutMs: 2500,
  deviceName: '',
  // Web viewer (`cli serve`). Local mode starts it automatically on 127.0.0.1.
  webHost: '127.0.0.1',
  webPort: 37800,
  webAutostart: true,
};

export function dataDir() {
  return process.env.CLAUDE_OPEN_MEM_DATA_DIR || path.join(os.homedir(), '.claude-open-mem');
}

export function dataPath(...parts) {
  return path.join(dataDir(), ...parts);
}

export function ensureDataDir() {
  // Owner-only: the database holds the user's whole history (mode is ignored on Windows).
  fs.mkdirSync(dataPath('logs'), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dataDir(), 0o700);
  } catch {}
}

export function loadSettings() {
  ensureDataDir();
  const file = dataPath('settings.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') log('warn', `settings.json unreadable, using defaults: ${err.message}`);
  }
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  if (!fs.existsSync(file)) saveSettings(settings);
  return settings;
}

// settings.json can hold a device key: keep it private to the user.
export function saveSettings(settings) {
  ensureDataDir();
  const file = dataPath('settings.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* not supported on every filesystem */ }
}

export function deviceName(settings) {
  return settings?.deviceName || os.hostname();
}

export function projectFromCwd(cwd) {
  const base = path.basename(path.resolve(cwd || process.cwd()));
  return base || 'default';
}

export function log(level, message) {
  try {
    ensureDataDir();
    fs.appendFileSync(dataPath('logs', 'open-mem.log'), `${new Date().toISOString()} [${level}] ${message}\n`);
  } catch {
    // Logging must never break a hook.
  }
}

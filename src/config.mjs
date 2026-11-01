// Paths and user settings for claude-open-mem.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.5.5';

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
  // How long Ollama keeps the model in (V)RAM after the last call. Long enough that the next drain finds it loaded
  // instead of reloading it; pauseWhenBusy (and the GPU guard) still unload it as soon as a game starts.
  llmKeepAlive: '10m',
  // While one of these runs, the queue waits and the Ollama models are unloaded (no LLM work while gaming).
  // busyProcesses: exe names (GTA5.exe) or path fragments (D:\Games\); busyPaths: game library folders.
  pauseWhenBusy: true,
  busyProcesses: [],
  busyPaths: ['/steamapps/common/', '/Epic Games/', '/XboxGames/', '/Riot Games/', '/EA Games/', '/GOG Galaxy/Games/',
    '/Ubisoft Game Launcher/games/'],
  // Launchers and background apps that live in those folders but are not games.
  busyIgnore: ['/wallpaper_engine/', '/Epic Games/Launcher/', '/Riot Games/Riot Client/'],
  // Tools whose calls are never recorded.
  skipTools: ['TodoWrite', 'AskUserQuestion', 'ListMcpResourcesTool', 'Skill', 'ToolSearch', 'SlashCommand'],
  maxToolChars: 6000,
  contextObservations: 12,
  contextSummaries: 3,
  contextTasks: 10,
  // At session start: warn when the repo is not on its default branch; in the first session of the day (from 05:00),
  // recap the last stretch of work across every project.
  branchWarning: true,
  dailyRecap: true,
  // Inject memory matching each prompt (FTS only, no LLM).
  recallOnPrompt: true,
  recallLimit: 5,
  // Regenerate a project's brief after this many new records.
  briefEvery: 25,
  // Ollama embedding model for semantic search ('' = full-text only). Each drain embeds up to embedPerDrain records.
  embedModel: 'embeddinggemma',
  embedPerDrain: 2000,
  // Ask the LLM which notes of a project look outdated, duplicated or contradictory, after a note changes
  // (at most once every notesReviewHours per project). Shown at session start.
  notesReview: true,
  notesReviewHours: 12,
  // Shared server (`cli serve`): drain the queue and run the upkeep above this often, in minutes (0 = never).
  serveDrainMinutes: 10,
  // Shared server whose Ollama runs on another machine: wake that machine (Wake-on-LAN, wakeMac '' = never) when queued
  // work waits for the LLM, and run wakeOffCommand wakeOffMinutes after its last LLM call. Only a machine this server
  // woke is turned off; the command exits 0 when it turned it off, 3 when the machine is in use and stays on.
  wakeMac: '',
  wakeBroadcast: '255.255.255.255',
  wakeOffMinutes: 10,
  wakeOffCommand: '',
  // Machine with the GPU, when a shared server uses it: `cli guard` lets the addresses in guardAllow reach this Ollama on
  // guardPort, and closes the door and frees the GPU while a game runs. Checked every guardPollSeconds while in use.
  guardAllow: [],
  guardPort: 11435,
  guardPollSeconds: 10,
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

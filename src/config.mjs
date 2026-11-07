// Paths and user settings for claude-open-mem.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.8.0';

export const DEFAULT_SETTINGS = {
  // auto: use a local Ollama if reachable, otherwise store without an LLM.
  // ollama | openai (any OpenAI-compatible endpoint) | none
  provider: 'auto',
  model: '',
  baseUrl: '',
  apiKey: '',
  llmTimeoutMs: 120000,
  // Once an LLM has been seen, the queue waits for it while it is down. Only after it stays unreachable for this long
  // (counting only the time this machine was in use) is the queue stored without it (the no-LLM path keeps only edits
  // and commands). A pause never counts.
  llmWaitHours: 72,
  // Start the local Ollama when it does not answer (Windows and macOS, loopback baseUrl only), at most every 10 minutes.
  ollamaAutostart: true,
  // Smaller chat models, best first, used instead of `model` when it does not fit in the free GPU memory, while another
  // app has a model loaded in Ollama, or while more than backlogItems wait in the queue (to catch up faster).
  fallbackModels: [],
  backlogItems: 500,
  // GPU budget for a local Ollama (needs nvidia-smi): open-mem only sends work when its model fits in the free video
  // memory minus OLLAMA_GPU_OVERHEAD and this reserve, and when loading it would not push another app's model out of
  // Ollama (OLLAMA_MAX_LOADED_MODELS).
  gpuBudget: true,
  gpuReserveMb: 1536,
  // Files or folders of marker files: while one exists, nothing is sent to the local Ollama and open-mem frees only its
  // own models. A JSON marker with `stale_after_s` counts only while its heartbeat (or mtime) is that fresh.
  busyFiles: ['~/.gpu-busy'],
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
  busyIgnore: ['/wallpaper_engine/', '/Epic Games/Launcher/', '/Epic Games/Epic Online Services/', '/Riot Games/Riot Client/'],
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
  // Stop recalling a record shown in this many sessions that never used it (fetched it or touched its files); 0 = never.
  recallMuteAfter: 5,
  // Regenerate a project's brief after this many new records.
  briefEvery: 25,
  // Ollama embedding model for semantic search ('' = full-text only). Each drain embeds up to embedPerDrain records.
  embedModel: 'embeddinggemma',
  embedPerDrain: 2000,
  // Ask the LLM which notes of a project look outdated, duplicated or contradictory, after a note changes
  // (at most once every notesReviewHours per project). Shown at session start.
  notesReview: true,
  notesReviewHours: 12,
  // Once a day per project with new bug fixes, ask the LLM which mistakes came back in two or more sessions, and
  // propose a rule for each. Shown on the project page of the web viewer only (nothing goes into Claude's context).
  lessonsReview: true,
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

const LOG_MAX_BYTES = 5 * 1024 * 1024;

// One rotated copy (open-mem.log.1): the log never grows past about twice LOG_MAX_BYTES.
export function log(level, message) {
  try {
    ensureDataDir();
    const file = dataPath('logs', 'open-mem.log');
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* no log yet, or another process rotated it first */ }
    fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${message}\n`);
  } catch {
    // Logging must never break a hook.
  }
}

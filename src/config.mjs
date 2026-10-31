// Paths and user settings for claude-open-mem.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.1.0';

export const DEFAULT_SETTINGS = {
  // auto: use a local Ollama if reachable, otherwise store without an LLM.
  // ollama | openai (any OpenAI-compatible endpoint) | none
  provider: 'auto',
  model: '',
  baseUrl: '',
  apiKey: '',
  llmTimeoutMs: 120000,
  // Tools whose calls are never recorded.
  skipTools: ['TodoWrite', 'AskUserQuestion', 'ListMcpResourcesTool', 'Skill', 'ToolSearch', 'SlashCommand'],
  maxToolChars: 6000,
  contextObservations: 30,
  contextSummaries: 5,
  excludedProjects: [],
  // Import new rows from an existing claude-mem database at session start.
  autoImportClaudeMem: true,
};

export function dataDir() {
  return process.env.CLAUDE_OPEN_MEM_DATA_DIR || path.join(os.homedir(), '.claude-open-mem');
}

export function dataPath(...parts) {
  return path.join(dataDir(), ...parts);
}

export function ensureDataDir() {
  fs.mkdirSync(dataPath('logs'), { recursive: true });
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

export function saveSettings(settings) {
  ensureDataDir();
  fs.writeFileSync(dataPath('settings.json'), JSON.stringify(settings, null, 2) + '\n');
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

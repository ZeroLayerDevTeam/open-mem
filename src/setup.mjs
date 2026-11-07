// `cli setup`: find Ollama, install it if missing (with the user's consent), and pull the model that fits this
// machine's GPU. The plan is built first (pure, tested) and shown before anything is downloaded or installed.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODELS, recommendModel } from './hardware.mjs';

export const OLLAMA_URL = 'http://127.0.0.1:11434';

const which = (file, args = ['--version']) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
});

// The ollama executable: PATH first, then where its installers put it.
export async function findOllama(platform = process.platform, env = process.env) {
  const candidates = ['ollama'];
  if (platform === 'win32') candidates.push(path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama.exe'));
  if (platform === 'darwin') candidates.push('/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama');
  if (platform === 'linux') candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama');
  for (const c of candidates) {
    if (c !== 'ollama' && !fs.existsSync(c)) continue;
    if (await which(c)) return c;
  }
  return null;
}

export async function ollamaModels(baseUrl = OLLAMA_URL) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return ((await res.json()).models || []).map((m) => m.name);
  } catch {
    return null; // not running or not reachable
  }
}

const hasModel = (names, model) => names.some((n) => n === model || n === `${model}:latest`);

// How to install Ollama here: a command to run, or only a page to open when no package manager can do it.
export async function installMethod(platform = process.platform) {
  if (platform === 'win32') {
    if (await which('winget')) {
      return { cmd: 'winget', args: ['install', '--id', 'Ollama.Ollama', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'] };
    }
    return { url: 'https://ollama.com/download/windows' };
  }
  if (platform === 'darwin') return (await which('brew')) ? { cmd: 'brew', args: ['install', 'ollama'] } : { url: 'https://ollama.com/download/mac' };
  if (platform === 'linux') return { cmd: 'sh', args: ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], sudo: true };
  return { url: 'https://ollama.com/download' };
}

// Everything setup would do, without doing it.
//   gpu: detectGpu(), installed: ollama binary or null, models: names Ollama serves (null when it does not answer),
//   opts: { model, cpu } from the command line.
export function planSetup({ gpu, installed, models, settings, opts = {} }) {
  const rec = recommendModel(gpu);
  const plan = { gpu, steps: [], warnings: [], model: null, embedModel: settings.embedModel || null, blocked: null };
  const chatAlready = (models || []).filter((n) => !/embed|bge|nomic|minilm/i.test(n));
  if (settings.provider === 'openai' || settings.provider === 'none') {
    plan.blocked = `provider is "${settings.provider}" in settings: setup only configures a local Ollama. Run \`config set provider auto\` first to use one.`;
    return plan;
  }
  if (opts.model) plan.model = opts.model;
  else if (rec.model) plan.model = rec.model;
  else if (chatAlready.length) plan.model = null; // no GPU here, but Ollama already answers (e.g. another machine's, through a tunnel)
  else if (opts.cpu) {
    plan.model = rec.cpuModel;
    plan.warnings.push(`No usable GPU: ${rec.cpuModel} will run on the CPU. It works, but each record takes many seconds and the CPU stays busy while the queue drains.`);
  } else {
    plan.blocked = 'No usable GPU found (integrated graphics do not count). open-mem still works without a local LLM, with fewer features:\n'
      + '  - no LLM: tool calls are stored as they are and full-text search works, but there are no summaries, briefs or semantic search;\n'
      + '  - a shared open-mem server on a machine with a GPU (`remote connect`, see the README);\n'
      + '  - any OpenAI-compatible endpoint (`config set provider openai`, plus baseUrl, model and apiKey);\n'
      + '  - a small model on the CPU: run `setup --cpu` (slow).';
    return plan;
  }
  if (plan.model && MODELS[plan.model]?.quality === 'low') {
    plan.warnings.push(`${plan.model} is the smallest model: observations will be shorter and rougher than with gemma3:12b.`);
  }
  if (!installed && models == null) plan.steps.push({ kind: 'install' });
  else if (models == null) plan.steps.push({ kind: 'start' });
  for (const m of [plan.model, plan.embedModel].filter(Boolean)) {
    if (!hasModel(models || [], m)) plan.steps.push({ kind: 'pull', model: m, sizeGb: MODELS[m]?.sizeGb ?? null });
  }
  plan.downloadGb = plan.steps.reduce((n, s) => n + (s.sizeGb || 0), 0);
  return plan;
}

export function runInstall(method) {
  return new Promise((resolve, reject) => {
    const child = spawn(method.cmd, method.args, { stdio: 'inherit', windowsHide: false });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${method.cmd} exited with code ${code}`))));
  });
}

// Start `ollama serve` in the background when nothing answers yet, then wait for it.
export async function ensureRunning(binary, baseUrl = OLLAMA_URL, waitMs = 30000) {
  if (await ollamaModels(baseUrl)) return true;
  if (binary) spawn(binary, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (const end = Date.now() + waitMs; Date.now() < end;) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await ollamaModels(baseUrl)) return true;
  }
  return false;
}

// Starts an installed Ollama that is not running, the way a login would. Returns how, or null when it cannot.
// Windows: the tray app through explorer.exe, so it gets the user's current environment (OLLAMA_* variables set
// after this process started included). macOS: the app. Linux runs Ollama as a system service: not ours to start.
export async function startOllama(platform = process.platform, env = process.env) {
  const launch = (cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  if (platform === 'win32') {
    const app = path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama app.exe');
    if (fs.existsSync(app)) { launch(path.join(env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [app]); return app; }
  } else if (platform === 'darwin' && fs.existsSync('/Applications/Ollama.app')) {
    launch('open', ['-a', 'Ollama']);
    return 'Ollama.app';
  }
  if (platform === 'linux') return null;
  const binary = await findOllama(platform, env);
  if (!binary) return null;
  launch(binary, ['serve']);
  return `${binary} serve`;
}

// Download a model through Ollama's API (no CLI needed); onProgress(fraction 0-1 or null, status).
export async function pullModel(name, baseUrl = OLLAMA_URL, onProgress = () => {}) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/pull`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`pull ${name}: HTTP ${res.status}`);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(`pull ${name}: ${msg.error}`);
      onProgress(msg.total ? (msg.completed || 0) / msg.total : null, msg.status);
    }
  }
}

// Claude Code hook entry: node hook.mjs <session-start|user-prompt|post-tool|stop>
// Reads the hook JSON on stdin. Must stay fast and never fail the user's session.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPath, deviceName, loadSettings, log, projectFromCwd } from './config.mjs';

// node:sqlite modules load only after the Node version check below.
let m;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');
const OWN_TOOLS = /^mcp__plugin_open-mem_/;

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function spawnCli(...args) {
  const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

function pidAlive(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const out = (obj) => process.stdout.write(JSON.stringify(obj));

async function sessionStart(db, input, settings, project) {
  const device = deviceName(settings);
  m.ensureSession(db, { sessionId: input.session_id, project, cwd: input.cwd, device, ...m.gitInfo(input.cwd) });
  // Lets skills/users find the CLI: node "$(cat ~/.claude-open-mem/plugin-root)/src/cli.mjs"
  fs.writeFileSync(dataPath('plugin-root'), ROOT);
  if (settings.autoImportClaudeMem && m.claudeMemDbPath()) spawnCli('import', '--quiet');
  m.spawnDrainer(); // also pushes unsynced rows in shared mode

  const notices = [];
  if (settings.mode !== 'remote') {
    // First run after install: create the web admin token and show it exactly once.
    const token = m.createAdminToken(db);
    const url = `http://${settings.webHost === '0.0.0.0' ? '127.0.0.1' : settings.webHost}:${settings.webPort}`;
    if (token) {
      notices.push(`claude-open-mem web viewer: ${url}\nAdmin token (shown only this once, store it in your password manager):\n${token}\n`
        + 'Lost it? Run the open-mem CLI: token reset');
    }
    if (settings.webAutostart && !pidAlive(dataPath('serve.pid'))) spawnCli('serve', '--quiet');
  }

  let { result: ctx, fallback } = await m.call('context', { project, cwd: input.cwd }, { db: () => db, settings });
  let text = ctx.text;
  if (fallback) text += '\n\n(open-mem: shared server unreachable, showing this machine\'s local memory.)';
  if (!m.getMeta(db, 'claude_mem_last_import_at') && m.claudeMemDbPath() && settings.autoImportClaudeMem) {
    text += '\n\n(claude-open-mem is importing your claude-mem history in the background; it will show up next session.)';
  }
  m.markInjected(db, input.session_id, ctx.refs || []);
  out({
    ...(notices.length ? { systemMessage: notices.join('\n\n') } : {}),
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  });
}

async function userPrompt(db, input, settings, project) {
  const device = deviceName(settings);
  m.addPrompt(db, { sessionId: input.session_id, project, cwd: input.cwd, device, text: input.prompt });
  if (!settings.recallOnPrompt) return;
  const exclude = [...m.injectedRefs(db, input.session_id)];
  const { result: rows } = await m.call('recall', { prompt: input.prompt, project, exclude, limit: settings.recallLimit },
    { db: () => db, settings });
  if (!rows?.length) return;
  m.markInjected(db, input.session_id, rows.map(m.refId));
  out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: m.formatRecall(rows) } });
}

function postTool(db, input, settings, project) {
  const tool = input.tool_name || '';
  if (!tool || settings.skipTools.includes(tool) || OWN_TOOLS.test(tool)) return;
  m.ensureSession(db, { sessionId: input.session_id, project, cwd: input.cwd, device: deviceName(settings) });
  m.enqueue(db, 'observation', input.session_id, project, {
    tool, input: input.tool_input, output: input.tool_response, tool_use_id: input.tool_use_id,
    prompt_number: m.currentPromptNumber(db, input.session_id), at: Date.now(),
  });
  m.spawnDrainer();
}

function stop(db, input, project) {
  const n = m.currentPromptNumber(db, input.session_id);
  if (!n) return;
  m.enqueue(db, 'summary', input.session_id, project, { prompt_number: n, transcript_path: input.transcript_path, at: Date.now() });
  m.spawnDrainer();
}

async function main() {
  const event = process.argv[2];
  const input = readStdin();
  if (!input.session_id) return;
  const settings = loadSettings();
  const project = projectFromCwd(input.cwd);
  if (settings.excludedProjects.some((p) => p.toLowerCase() === project.toLowerCase())) return;
  const db = m.openDb();
  try {
    if (event === 'session-start') await sessionStart(db, input, settings, project);
    else if (event === 'user-prompt' && input.prompt) await userPrompt(db, input, settings, project);
    else if (event === 'post-tool') postTool(db, input, settings, project);
    else if (event === 'stop') stop(db, input, project);
  } finally {
    db.close();
  }
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  log('error', `Node ${process.versions.node} is too old; claude-open-mem needs Node >= 22.13 (node:sqlite).`);
  if (process.argv[2] === 'session-start') {
    process.stdout.write(`claude-open-mem disabled: needs Node >= 22.13, found ${process.versions.node}.`);
  }
} else {
  try {
    m = {
      ...(await import('./db.mjs')),
      ...(await import('./auth.mjs')),
      ...(await import('./backend.mjs')),
      ...(await import('./claudemem.mjs')),
      ...(await import('./meta.mjs')),
      ...(await import('./queue.mjs')),
      ...(await import('./store.mjs')),
    };
    await main();
  } catch (err) {
    log('error', `hook ${process.argv[2]} failed: ${err.stack || err.message}`);
  }
}

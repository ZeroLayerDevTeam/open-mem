// Claude Code hook entry: node hook.mjs <session-start|user-prompt|post-tool|stop>
// Reads the hook JSON on stdin. Must stay fast and never fail the user's session.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPath, deviceName, loadSettings, log, projectFromCwd } from './config.mjs';
import { forwardToNewest } from './newest.mjs';

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

// Once per machine: no LLM answers, so tell the user (not Claude: systemMessage) how to set one up.
async function setupHint(db, settings) {
  if ((settings.provider || 'auto') !== 'auto' || m.getMeta(db, 'setup_hint_at')) return null;
  m.setMeta(db, 'setup_hint_at', Date.now());
  if ((await m.resolveProvider(settings)).kind !== 'none') return null;
  return 'claude-open-mem: no local LLM found, so tool calls are stored as they are, without summaries, project briefs or '
    + 'semantic search. Setup checks your GPU, installs Ollama and the model that fits it, and asks before downloading anything:\n'
    + `  node "${path.join(ROOT, 'src', 'cli.mjs')}" setup\n`
    + 'Without a usable GPU it lists the other options (shared server, OpenAI-compatible endpoint, CPU).';
}

async function sessionStart(db, input, settings, project) {
  const device = deviceName(settings);
  const git = m.gitInfo(input.cwd);
  // First session of this machine's working day (since 05:00): recap the last stretch of work, every project.
  const dayStart = m.workdayStart();
  const firstToday = settings.dailyRecap && !db.prepare('SELECT 1 FROM sessions WHERE started_at >= ? AND session_id != ? LIMIT 1')
    .get(dayStart, input.session_id);
  m.ensureSession(db, { sessionId: input.session_id, project, cwd: input.cwd, device, ...git });
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
  if (settings.guardAllow.length && !pidAlive(dataPath('guard.pid'))) spawnCli('guard', '--quiet');
  const hint = await setupHint(db, settings);
  if (hint) notices.push(hint);
  const down = m.downNotice(db);
  if (down) notices.push(down);

  const args = { project, cwd: input.cwd, ...(firstToday ? { recap: { until: dayStart, tz: new Date().getTimezoneOffset() } } : {}) };
  let { result: ctx, fallback } = await m.call('context', args, { db: () => db, settings });
  let text = ctx.text;
  const branch = settings.branchWarning ? m.branchWarning(input.cwd, git.gitBranch) : null;
  if (branch) text = `> open-mem: ${branch}\n\n${text}`;
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
  const exclude = [...m.injectedRefs(db, input.session_id), ...m.mutedRefs(db, settings.recallMuteAfter)];
  const { result: rows } = await m.call('recall', { prompt: input.prompt, project, exclude, limit: settings.recallLimit },
    { db: () => db, settings });
  if (!rows?.length) return;
  m.markInjected(db, input.session_id, rows.map(m.refId));
  m.logRecall(db, input.session_id, rows);
  out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: m.formatRecall(rows) } });
}

const FETCH_TOOLS = /^mcp__plugin_open-mem_open-mem__(get_observations|timeline)$/;

// Did this call use something prompt recall showed? A fetch of the record, or work on one of its files.
function noteRecallUse(db, input, tool) {
  const ti = input.tool_input || {};
  if (FETCH_TOOLS.test(tool)) {
    m.markRecallUsed(db, input.session_id, { refs: [...(Array.isArray(ti.ids) ? ti.ids : []), ti.anchor].filter((x) => x != null) });
  } else if (ti.file_path || ti.notebook_path) {
    m.markRecallUsed(db, input.session_id, { file: ti.file_path || ti.notebook_path });
  }
}

function postTool(db, input, settings, project) {
  const tool = input.tool_name || '';
  if (settings.recallOnPrompt) noteRecallUse(db, input, tool);
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
// A session started before an update still runs this folder: the newest installed version handles the hook instead.
if (forwardToNewest(ROOT, path.join('src', 'hook.mjs'))) {
  // done by the newer copy
} else if (major < 22 || (major === 22 && minor < 13)) {
  log('error', `Node ${process.versions.node} is too old; claude-open-mem needs Node >= 22.13 (node:sqlite).`);
  if (process.argv[2] === 'session-start') {
    process.stdout.write(`claude-open-mem disabled: needs Node >= 22.13, found ${process.versions.node}.`);
  }
} else {
  try {
    m = {
      ...(await import('./db.mjs')),
      ...(await import('./llm.mjs')),
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

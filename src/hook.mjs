// Claude Code hook entry: node hook.mjs <session-start|user-prompt|post-tool|stop>
// Reads the hook JSON on stdin. Must stay fast and never fail the user's session.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPath, loadSettings, log, projectFromCwd } from './config.mjs';

// node:sqlite modules load only after the Node version check below.
let getMeta, openDb, claudeMemDbPath, enqueue, spawnDrainer, addPrompt, contextFor, currentPromptNumber, ensureSession;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWN_TOOLS = /^mcp__plugin_open-mem_/;

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function spawnImport() {
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'src', 'cli.mjs'), 'import', '--quiet'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}

function sessionStart(db, input, settings, project) {
  ensureSession(db, { sessionId: input.session_id, project, cwd: input.cwd });
  // Lets skills/users find the CLI: node "$(cat ~/.claude-open-mem/plugin-root)/src/cli.mjs"
  fs.writeFileSync(dataPath('plugin-root'), ROOT);
  if (settings.autoImportClaudeMem && claudeMemDbPath()) spawnImport();
  spawnDrainer();
  let context = contextFor(db, project, settings);
  if (!getMeta(db, 'claude_mem_last_import_at') && claudeMemDbPath() && settings.autoImportClaudeMem) {
    context += '\n\n(claude-open-mem is importing your claude-mem history in the background; it will show up next session.)';
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
}

function postTool(db, input, settings, project) {
  const tool = input.tool_name || '';
  if (!tool || settings.skipTools.includes(tool) || OWN_TOOLS.test(tool)) return;
  ensureSession(db, { sessionId: input.session_id, project, cwd: input.cwd });
  enqueue(db, 'observation', input.session_id, project, {
    tool, input: input.tool_input, output: input.tool_response,
    prompt_number: currentPromptNumber(db, input.session_id), at: Date.now(),
  });
  spawnDrainer();
}

function stop(db, input, project) {
  const n = currentPromptNumber(db, input.session_id);
  if (!n) return;
  enqueue(db, 'summary', input.session_id, project, { prompt_number: n, transcript_path: input.transcript_path, at: Date.now() });
  spawnDrainer();
}

function main() {
  const event = process.argv[2];
  const input = readStdin();
  if (!input.session_id) return;
  const settings = loadSettings();
  const project = projectFromCwd(input.cwd);
  if (settings.excludedProjects.some((p) => p.toLowerCase() === project.toLowerCase())) return;
  const db = openDb();
  try {
    if (event === 'session-start') sessionStart(db, input, settings, project);
    else if (event === 'user-prompt' && input.prompt) addPrompt(db, { sessionId: input.session_id, project, cwd: input.cwd, text: input.prompt });
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
    ({ getMeta, openDb } = await import('./db.mjs'));
    ({ claudeMemDbPath } = await import('./claudemem.mjs'));
    ({ enqueue, spawnDrainer } = await import('./queue.mjs'));
    ({ addPrompt, contextFor, currentPromptNumber, ensureSession } = await import('./store.mjs'));
    main();
  } catch (err) {
    log('error', `hook ${process.argv[2]} failed: ${err.stack || err.message}`);
  }
}

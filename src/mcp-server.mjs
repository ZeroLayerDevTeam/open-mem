// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). No dependencies.
import readline from 'node:readline';
import { deviceName, loadSettings, log, projectFromCwd, VERSION } from './config.mjs';
import { openDb } from './db.mjs';
import { call } from './backend.mjs';
import { formatItems } from './items.mjs';
import { formatFull, formatIndex } from './store.mjs';

const INSTRUCTIONS = `claude-open-mem: persistent memory across Claude Code sessions (shared across the user's machines).
Recall: search(query) -> timeline(anchor) -> get_observations(ids), fetching only what you need.
Ids: numbers = observations, S<n> = session summaries, I<n> = notes and tasks.
Durable work tracking: task_add / task_update (todo -> doing -> done) instead of TodoWrite for anything that
must survive this session; note_add for decisions, conventions, gotchas and user preferences.
Notes and tasks default to the current project (folder name) and directory.`;

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const TOOLS = [
  {
    name: 'search',
    description: 'Full-text search over observations, session summaries, notes and tasks. Returns a compact index (id · date · project · type · title). Empty query lists the most recent.',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('Words to search for (prefix matching; all words first, any word as fallback)'),
        project: str('Limit to a project (folder name). Omit for all projects.'),
        type: str('Observation type (discovery, decision, bugfix, feature, refactor, change) or note / task'),
        kind: { type: 'string', enum: ['all', 'observations', 'summaries', 'notes', 'tasks'] },
        dateStart: str('ISO date, e.g. 2026-10-01'),
        dateEnd: str('ISO date, inclusive'),
        limit: { type: 'number', description: 'Default 20, max 100' },
        offset: { type: 'number' },
      },
    },
  },
  {
    name: 'timeline',
    description: 'Records of the same project just before and after an anchor id, in time order.',
    inputSchema: {
      type: 'object',
      properties: {
        anchor: str('Observation id (e.g. "123") or summary id (e.g. "S45")'),
        before: { type: 'number', description: 'Default 5' },
        after: { type: 'number', description: 'Default 5' },
      },
      required: ['anchor'],
    },
  },
  {
    name: 'get_observations',
    description: 'Full details of selected records (max 50): observations, S<n> summaries or I<n> notes/tasks with their history.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: ['string', 'number'] } } }, required: ['ids'] },
  },
  {
    name: 'project_context',
    description: 'The start-of-session brief for a project: summary, open tasks, recent sessions, hot files, notes. Use it when switching to another project.',
    inputSchema: { type: 'object', properties: { project: str('Project (folder name). Defaults to the current one.') } },
  },
  {
    name: 'note_add',
    description: 'Save a durable note: a decision, convention, gotcha, user preference or handoff. Prefer short, specific notes.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('One line'),
        body: str('Details (markdown)'),
        project: str('Defaults to the current project'),
        directory: str('Defaults to the current working directory'),
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
  },
  {
    name: 'task_add',
    description: 'Create a durable task/to-do that survives this session and is visible on every machine and in the web viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('What needs doing, as an action'),
        body: str('Details, acceptance criteria, links'),
        status: { type: 'string', enum: ['todo', 'doing', 'blocked'], description: 'Default todo' },
        priority: { type: 'number', enum: [1, 2, 3], description: '1 high, 2 normal (default), 3 low' },
        due: str('ISO date'),
        project: str('Defaults to the current project'),
        directory: str('Defaults to the current working directory'),
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
  },
  {
    name: 'task_update',
    description: 'Update a note or task by id (I<n>): change status (todo, doing, blocked, done, cancelled; notes: active, archived), edit fields, or add a progress comment.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('I<n> or n'),
        status: str('New status'),
        comment: str('Progress note recorded in the history'),
        title: str('New title'),
        body: str('New body'),
        priority: { type: 'number', enum: [1, 2, 3] },
        due: str('ISO date, or empty to clear'),
        tags: { type: 'array', items: { type: 'string' } },
        project: str('Move to another project'),
      },
      required: ['id'],
    },
  },
  {
    name: 'items_list',
    description: 'List notes and/or tasks, open ones first.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['note', 'task'] },
        project: str('Defaults to the current project; "*" for all'),
        status: str('Exact status filter'),
        open: { type: 'boolean', description: 'Only open tasks / active notes' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'save_memory',
    description: 'Alias of note_add kept for compatibility: save an explicit note.',
    inputSchema: {
      type: 'object',
      properties: { text: str('The note'), title: str('One line'), project: str('Defaults to the current project') },
      required: ['text'],
    },
  },
];

let db;
const settings = loadSettings();
const ctx = { db: () => (db ??= openDb()), settings };
const here = () => ({ project: projectFromCwd(process.cwd()), directory: process.cwd() });
const idOf = (v) => {
  const n = Number(String(v ?? '').trim().replace(/^i/i, ''));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid id "${v}" (expected I<n>)`);
  return n;
};
const where = (r) => (r.fallback ? ' (server unreachable: saved locally, it will sync later)' : '');

async function callTool(name, a = {}) {
  switch (name) {
    case 'search':
      return formatIndex((await call('search', a, ctx)).result);
    case 'timeline': {
      const { result } = await call('timeline', { anchor: a.anchor, before: Math.min(a.before ?? 5, 50), after: Math.min(a.after ?? 5, 50) }, ctx);
      return result ? formatIndex(result) : `Anchor ${a.anchor} not found.`;
    }
    case 'get_observations':
      return formatFull((await call('get', { ids: (Array.isArray(a.ids) ? a.ids : [a.ids]).map(String) }, ctx)).result);
    case 'project_context':
      return (await call('context', { project: a.project || here().project }, ctx)).result.text;
    case 'save_memory':
    case 'note_add': {
      const title = a.title || (a.text ? a.text.split('\n')[0].slice(0, 120) : '');
      const r = await call('itemAdd', { kind: 'note', ...here(), ...a, title, body: a.body ?? a.text ?? null }, ctx);
      return `Saved note I${r.result.id} in project "${a.project || here().project}"${where(r)}.`;
    }
    case 'task_add': {
      const r = await call('itemAdd', { kind: 'task', ...here(), ...a }, ctx);
      return `Created task I${r.result.id} [${a.status || 'todo'}] in project "${a.project || here().project}"${where(r)}.`;
    }
    case 'task_update': {
      const { id, ...patch } = a;
      const r = await call('itemUpdate', { id: idOf(id), patch }, ctx);
      return `Updated I${r.result.id} → [${r.result.status}] ${r.result.title}${where(r)}.`;
    }
    case 'items_list': {
      const project = a.project === '*' ? undefined : a.project || here().project;
      return formatItems((await call('itemsList', { ...a, project }, ctx)).result);
    }
    default:
      throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-open-mem', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      try {
        return { content: [{ type: 'text', text: await callTool(params?.name, params?.arguments) }] };
      } catch (err) {
        if (err.code === -32602) throw err;
        log('warn', `mcp tool ${params?.name} on ${deviceName(settings)}: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    default:
      if (id === undefined) return undefined; // notification
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const pending = new Set();

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const p = handle(msg).then(
    (result) => { if (msg.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result }); },
    (err) => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } }); },
  ).finally(() => pending.delete(p));
  pending.add(p);
}).on('close', async () => {
  await Promise.allSettled([...pending]);
  db?.close();
  process.exit(0);
});

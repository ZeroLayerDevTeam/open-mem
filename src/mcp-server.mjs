// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). No dependencies.
import readline from 'node:readline';
import { log, projectFromCwd, VERSION } from './config.mjs';
import { openDb } from './db.mjs';
import { formatFull, formatIndex, getByRefs, insertObservation, search, timeline } from './store.mjs';

const INSTRUCTIONS = `claude-open-mem: persistent memory across Claude Code sessions.
Workflow: search(query) for a compact index -> timeline(anchor) for what happened around a hit ->
get_observations(ids) only for the records you need. Ids are numbers for observations and S<n> for session summaries.
Project = the folder name of the working directory. Use save_memory for decisions, corrections or lessons worth keeping.`;

const TOOLS = [
  {
    name: 'search',
    description: 'Full-text search over past observations and session summaries. Returns a compact index (id · date · project · type · title). Empty query lists the most recent.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for (prefix matching; all words first, any word as fallback)' },
        project: { type: 'string', description: 'Limit to a project (folder name). Omit for all projects.' },
        type: { type: 'string', description: 'Observation type: discovery, decision, bugfix, feature, refactor, change, note' },
        kind: { type: 'string', enum: ['all', 'observations', 'summaries'] },
        dateStart: { type: 'string', description: 'ISO date, e.g. 2026-10-01' },
        dateEnd: { type: 'string', description: 'ISO date, inclusive' },
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
        anchor: { type: 'string', description: 'Observation id (e.g. "123") or summary id (e.g. "S45")' },
        before: { type: 'number', description: 'Default 5' },
        after: { type: 'number', description: 'Default 5' },
      },
      required: ['anchor'],
    },
  },
  {
    name: 'get_observations',
    description: 'Full details of selected records (max 50). Fetch only ids chosen from search or timeline.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: ['string', 'number'] } } },
      required: ['ids'],
    },
  },
  {
    name: 'save_memory',
    description: 'Save an explicit note (decision, correction, lesson, handoff) to memory.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        title: { type: 'string' },
        project: { type: 'string', description: 'Defaults to the current folder name' },
      },
      required: ['text'],
    },
  },
];

let db;
const getDb = () => (db ??= openDb());

function callTool(name, a = {}) {
  switch (name) {
    case 'search':
      return formatIndex(search(getDb(), a));
    case 'timeline': {
      const rows = timeline(getDb(), a.anchor, Math.min(a.before ?? 5, 50), Math.min(a.after ?? 5, 50));
      return rows ? formatIndex(rows) : `Anchor ${a.anchor} not found.`;
    }
    case 'get_observations':
      return formatFull(getByRefs(getDb(), Array.isArray(a.ids) ? a.ids : [a.ids]));
    case 'save_memory': {
      if (!a.text?.trim()) throw new Error('text is required');
      const project = a.project || projectFromCwd(process.cwd());
      const id = insertObservation(getDb(), {
        project, type: 'note', title: a.title || a.text.slice(0, 80), narrative: a.text, tool: 'save_memory', created_at: Date.now(),
      });
      return `Saved as ${id} in project "${project}".`;
    }
    default:
      throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
  }
}

function handle(msg) {
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
        return { content: [{ type: 'text', text: callTool(params?.name, params?.arguments) }] };
      } catch (err) {
        if (err.code === -32602) throw err;
        log('warn', `mcp tool ${params?.name}: ${err.message}`);
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    default:
      if (id === undefined) return undefined; // notification
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  try {
    const result = handle(msg);
    if (msg.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (err) {
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } });
  }
}).on('close', () => {
  db?.close();
  process.exit(0);
});

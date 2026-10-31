#!/usr/bin/env node
// claude-open-mem CLI (see HELP).
import fs from 'node:fs';
import { addDevice, createAdminToken, hasAdminToken, listDevices, removeDevice } from './auth.mjs';
import { DEFAULT_SETTINGS, dataDir, dataPath, deviceName, loadSettings, log, saveSettings, VERSION } from './config.mjs';
import { openDb } from './db.mjs';
import { claudeMemDbPath, installedPluginIds, importClaudeMem, uninstallClaudeMem } from './claudemem.mjs';
import { resolveProvider } from './llm.mjs';
import { drain, generateBrief } from './queue.mjs';
import { serve } from './server.mjs';
import { formatIndex, redactExisting, search, stats } from './store.mjs';
import { pushPending, remoteFetch } from './sync.mjs';

const HELP = `claude-open-mem ${VERSION}
Usage: node cli.mjs <command> [options]

  status                         Database counts, LLM provider, mode, claude-mem detection
  import [--quiet]               Import new rows from claude-mem (read-only, incremental)
  drain                          Process the pending queue now
  search <query> [--project P]   Search memory from the terminal
  redact                         Re-scan stored memory and redact secrets
  brief <project>                Regenerate a project's brief now (needs an LLM)
  config                         Show settings
  config set <key> <value>       Change a setting (e.g. provider ollama, model gemma3:12b)
  uninstall-claude-mem [--move-data] [--dry-run] [--yes]
                                 Final import, then uninstall the claude-mem plugin and stop its worker.
                                 --move-data renames ~/.claude-mem (never deletes it).

Web viewer and shared mode
  serve [--host H] [--port P]    Run the web viewer + API (default ${DEFAULT_SETTINGS.webHost}:${DEFAULT_SETTINGS.webPort})
  token init | token reset       Create (or replace) the web admin token. Printed once; only its hash is kept.
  device add <name> [--raw]      Server: create a key for a client machine (printed once)
  device list | device remove <name>
  remote connect --url URL [--name DEVICE] < keyfile
                                 Client: use a shared server (device key read from standard input)
  remote disconnect              Client: back to this machine's local database
  sync                           Client: push unsynced records to the server now
Data: ${dataDir()}`;

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function option(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const [, v] = args.splice(i, 2);
  return v;
}

function parseValue(key, raw) {
  const def = DEFAULT_SETTINGS[key];
  if (typeof def === 'number') return Number(raw);
  if (typeof def === 'boolean') return raw === 'true';
  if (Array.isArray(def)) return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return raw;
}

// Overwrite one line on a terminal; a pipe or log only gets the final result.
const progress = (x) => process.stdout.isTTY && process.stdout.write(`\rpushed ${JSON.stringify(x)}`);

async function main() {
  const [cmd = 'help', ...args] = process.argv.slice(2);
  const settings = loadSettings();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (cmd === 'config') {
    if (args[0] === 'set') {
      const [, key, ...rest] = args;
      if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting "${key}". Known: ${Object.keys(DEFAULT_SETTINGS).join(', ')}`);
      if (key === 'deviceKey') throw new Error('use `remote connect` to set the device key (it is read from stdin)');
      settings[key] = parseValue(key, rest.join(' '));
      saveSettings(settings);
    }
    const shown = { ...settings, apiKey: settings.apiKey ? '***' : '', deviceKey: settings.deviceKey ? '***' : '' };
    return console.log(JSON.stringify(shown, null, 2));
  }

  const db = openDb();
  let keepOpen = false;
  try {
    if (cmd === 'status') {
      const s = stats(db);
      const provider = await resolveProvider(settings);
      console.log(`claude-open-mem ${VERSION}  data: ${dataDir()}`);
      console.log(`observations ${s.observations} (imported ${s.imported}) · summaries ${s.summaries} · prompts ${s.prompts}`);
      console.log(`notes ${s.notes} · tasks ${s.tasks} · queue pending ${s.queuePending} · failed ${s.queueFailed}`);
      console.log(`LLM: ${provider.kind}${provider.model ? ` (${provider.model} @ ${provider.baseUrl})` : ''}${provider.reason ? ` — ${provider.reason}` : ''}`);
      console.log(`mode ${settings.mode}${settings.mode === 'remote' ? ` → ${settings.serverUrl} as ${deviceName(settings)} · unsynced ${s.unsynced}` : ''}`
        + ` · web admin token ${hasAdminToken(db) ? 'set' : 'not set'}`);
      const cm = claudeMemDbPath();
      console.log(`claude-mem: ${cm ? `database ${cm}` : 'no database'} · plugin ${installedPluginIds().join(', ') || 'not installed'}`);
      if (s.projects.length) console.log(`top projects: ${s.projects.map((p) => `${p.project} ${p.n}`).join(', ')}`);
    } else if (cmd === 'import') {
      const quiet = flag(args, '--quiet');
      const r = importClaudeMem(db, undefined, { device: deviceName(settings) });
      const line = r.ok ? `imported from ${r.file}: ${r.results.map((x) => `${x.name} +${x.added}`).join(', ')}` : r.reason;
      log('info', line);
      if (!quiet) console.log(line);
    } else if (cmd === 'redact') {
      console.log(`redacted ${redactExisting(db)} rows`);
    } else if (cmd === 'drain') {
      const n = await drain(db, settings);
      log('info', `drain handled ${n} items`);
    } else if (cmd === 'search') {
      const project = option(args, '--project');
      console.log(formatIndex(search(db, { query: args.join(' '), project, limit: 30 })));
    } else if (cmd === 'brief') {
      const provider = await resolveProvider(settings);
      if (provider.kind === 'none') throw new Error(`no LLM available: ${provider.reason}`);
      console.log((await generateBrief(db, args.join(' '), provider, settings)) ? 'brief updated' : 'no summaries for that project');
    } else if (cmd === 'uninstall-claude-mem') {
      const dryRun = flag(args, '--dry-run');
      const moveData = flag(args, '--move-data');
      if (!dryRun && !flag(args, '--yes')) {
        console.log('This uninstalls the claude-mem plugin (your claude-mem data stays on disk).');
        console.log('Re-run with --yes to proceed, or --dry-run to preview.');
        return;
      }
      for (const step of uninstallClaudeMem(db, { moveData, dryRun })) console.log(`- ${step}`);
      if (!dryRun) console.log('Restart Claude Code so the removed hooks stop loading.');
    } else if (cmd === 'serve') {
      keepOpen = await serveCmd(db, settings, args);
    } else if (cmd === 'token') {
      if (args[0] !== 'init' && args[0] !== 'reset') throw new Error('usage: token init | token reset');
      const token = createAdminToken(db, { reset: args[0] === 'reset' });
      if (!token) return console.log('An admin token already exists. `token reset` replaces it and logs out every browser.');
      console.log(`Web admin token (shown only now; store it in your password manager):\n${token}`);
    } else if (cmd === 'device') {
      deviceCmd(db, args);
    } else if (cmd === 'remote') {
      await remoteCmd(db, settings, args);
    } else if (cmd === 'sync') {
      if (settings.mode !== 'remote') throw new Error('not in remote mode (see `remote connect`)');
      console.log(`\nsync done: ${JSON.stringify(await pushPending(db, settings, { onProgress: progress }))}`);
    } else {
      console.log(HELP);
      process.exitCode = 1;
    }
  } finally {
    if (!keepOpen) db.close();
  }
}

async function serveCmd(db, settings, args) {
  const quiet = flag(args, '--quiet');
  const host = option(args, '--host') || settings.webHost;
  const port = Number(option(args, '--port') || settings.webPort);
  try {
    await serve(db, settings, { host, port });
  } catch (err) {
    if (err.code === 'EADDRINUSE' && quiet) return false; // autostart: another instance already serves
    throw err;
  }
  fs.writeFileSync(dataPath('serve.pid'), String(process.pid));
  const msg = `open-mem web viewer on http://${host}:${port}${hasAdminToken(db) ? '' : ' (no admin token yet: run `token init`)'}`;
  log('info', msg);
  if (!quiet) console.log(msg);
  const stop = () => {
    try { if (Number(fs.readFileSync(dataPath('serve.pid'), 'utf8')) === process.pid) fs.rmSync(dataPath('serve.pid')); } catch { /* gone */ }
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return true;
}

function deviceCmd(db, args) {
  const raw = flag(args, '--raw');
  const [sub, name] = args;
  if (sub === 'add') {
    const key = addDevice(db, name);
    if (raw) return process.stdout.write(key);
    console.log(`Device key for "${name}" (shown only now). On that machine run`);
    console.log(`  node <plugin>/src/cli.mjs remote connect --url http://<this-server>:${DEFAULT_SETTINGS.webPort} --name ${name}`);
    console.log(`and give it this key on standard input:\n${key}`);
  } else if (sub === 'remove') {
    console.log(removeDevice(db, name) ? `removed ${name}` : `no device ${name}`);
  } else {
    const rows = listDevices(db);
    if (!rows.length) return console.log('No devices.');
    for (const d of rows) {
      console.log(`${d.name}  created ${new Date(d.created_at).toISOString().slice(0, 10)}  last seen ${d.last_seen_at ? new Date(d.last_seen_at).toISOString() : 'never'}`);
    }
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function remoteCmd(db, settings, args) {
  const sub = args.shift();
  if (sub === 'disconnect') {
    saveSettings({ ...settings, mode: 'local', serverUrl: '', deviceKey: '' });
    return console.log('Back to local mode. Records already pushed stay on the server.');
  }
  if (sub !== 'connect') throw new Error('usage: remote connect --url URL [--name DEVICE] < keyfile  |  remote disconnect');
  const url = option(args, '--url');
  if (!/^https?:\/\/[^/]+/.test(url || '')) throw new Error('--url must look like http://192.168.0.10:37800');
  const name = option(args, '--name');
  const key = await readStdin();
  if (!key.startsWith('om_dev_')) throw new Error('expected a device key (om_dev_...) on standard input');
  const next = { ...settings, mode: 'remote', serverUrl: url.replace(/\/+$/, ''), deviceKey: key, ...(name ? { deviceName: name } : {}) };
  const me = await remoteFetch(next, 'GET', '/api/me', null, 5000);
  if (me.kind !== 'device') throw new Error('the server did not accept that device key');
  saveSettings(next);
  console.log(`Connected to ${next.serverUrl} as ${deviceName(next)}. Pushing this machine's memory...`);
  console.log(`\ndone: ${JSON.stringify(await pushPending(db, next, { onProgress: progress }))}`);
}

main().catch((err) => {
  log('error', `cli ${process.argv[2]}: ${err.stack || err.message}`);
  console.error(err.message);
  process.exitCode = 1;
});

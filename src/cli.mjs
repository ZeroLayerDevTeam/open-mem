#!/usr/bin/env node
// claude-open-mem CLI: status | import | drain | config | uninstall-claude-mem | search
import { DEFAULT_SETTINGS, dataDir, loadSettings, log, saveSettings, VERSION } from './config.mjs';
import { openDb } from './db.mjs';
import { claudeMemDbPath, installedPluginIds, importClaudeMem, uninstallClaudeMem } from './claudemem.mjs';
import { resolveProvider } from './llm.mjs';
import { drain } from './queue.mjs';
import { formatIndex, redactExisting, search, stats } from './store.mjs';

const HELP = `claude-open-mem ${VERSION}
Usage: node cli.mjs <command> [options]

  status                         Database counts, LLM provider, claude-mem detection
  import [--quiet]               Import new rows from claude-mem (read-only, incremental)
  drain                          Process the pending queue now
  search <query> [--project P]   Search memory from the terminal
  redact                         Re-scan stored memory and redact secrets
  config                         Show settings
  config set <key> <value>       Change a setting (e.g. provider ollama, model qwen3:8b)
  uninstall-claude-mem [--move-data] [--dry-run] [--yes]
                                 Final import, then uninstall the claude-mem plugin and stop its worker.
                                 --move-data renames ~/.claude-mem (never deletes it).
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

async function main() {
  const [cmd = 'help', ...args] = process.argv.slice(2);
  const settings = loadSettings();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (cmd === 'config') {
    if (args[0] === 'set') {
      const [, key, ...rest] = args;
      if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting "${key}". Known: ${Object.keys(DEFAULT_SETTINGS).join(', ')}`);
      settings[key] = parseValue(key, rest.join(' '));
      saveSettings(settings);
    }
    const shown = { ...settings, apiKey: settings.apiKey ? '***' : '' };
    return console.log(JSON.stringify(shown, null, 2));
  }

  const db = openDb();
  try {
    if (cmd === 'status') {
      const s = stats(db);
      const provider = await resolveProvider(settings);
      console.log(`claude-open-mem ${VERSION}  data: ${dataDir()}`);
      console.log(`observations ${s.observations} (imported ${s.imported}) · summaries ${s.summaries} · prompts ${s.prompts}`);
      console.log(`queue pending ${s.queuePending} · failed ${s.queueFailed}`);
      console.log(`LLM: ${provider.kind}${provider.model ? ` (${provider.model} @ ${provider.baseUrl})` : ''}${provider.reason ? ` — ${provider.reason}` : ''}`);
      const cm = claudeMemDbPath();
      console.log(`claude-mem: ${cm ? `database ${cm}` : 'no database'} · plugin ${installedPluginIds().join(', ') || 'not installed'}`);
      if (s.projects.length) console.log(`top projects: ${s.projects.map((p) => `${p.project} ${p.n}`).join(', ')}`);
    } else if (cmd === 'import') {
      const quiet = flag(args, '--quiet');
      const r = importClaudeMem(db);
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
    } else {
      console.log(HELP);
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  log('error', `cli ${process.argv[2]}: ${err.stack || err.message}`);
  console.error(err.message);
  process.exitCode = 1;
});

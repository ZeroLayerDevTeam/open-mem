# claude-open-mem

Open, local-first persistent memory for [Claude Code](https://claude.com/claude-code).

claude-open-mem records what happens in your Claude Code sessions, compresses it into searchable observations and
session summaries, and hands Claude a compact brief of each project at the start of every session, so it can start
working instead of re-exploring the codebase. It is a drop-in alternative to [claude-mem](https://cmem.ai/) and
imports your claude-mem history automatically.

**It never spends your Claude plan.** Compression runs on a local LLM through [Ollama](https://ollama.com), on any
OpenAI-compatible endpoint you choose, or without any LLM at all.

- Zero dependencies: Node.js ≥ 22.13 built-ins only (`node:sqlite` with FTS5).
- One SQLite file in `~/.claude-open-mem/`, or one shared server for all your machines.
- **Fast session start**: a per-project brief, open tasks, last next steps and hot files, in ~3 KB of context.
- **Prompt-time recall**: each prompt gets the few past records that match it, never the same one twice.
- **Notes and tasks** that Claude creates and updates itself, with a status history, per project and directory.
- **Web viewer**: progress, projects, timeline, task board, notes, search and sessions, protected by an admin token.
- Every record carries reconstruction metadata: machine, working directory, git branch and commit, model, tool, files.
- Automatic, incremental, read-only import from claude-mem; optional claude-mem uninstall.

## Install

Requirements: Claude Code, Node.js ≥ 22.13 on `PATH`. Optional: Ollama with a chat model
(`ollama pull gemma3:12b`, or `gemma3:4b` / `qwen3:8b` on smaller GPUs).

```bash
claude plugin marketplace add Noel18101987/claude-open-mem
# or from the GitLab mirror: claude plugin marketplace add https://gitlab.com/noelcheda/claude-open-mem.git
claude plugin install open-mem@claude-open-mem
```

Restart Claude Code. On the first session start claude-open-mem:

1. creates `~/.claude-open-mem/` with `settings.json` and `open-mem.db`;
2. generates a random **web admin token and shows it once** in the session — save it in your password manager
   (only its SHA-256 hash is stored);
3. starts the web viewer on <http://127.0.0.1:37800>;
4. imports your claude-mem database in the background if it finds one (`~/.claude-mem/claude-mem.db`);
5. starts injecting memory for the current project.

The plugin id is `open-mem` (Claude Code reserves plugin names that start with `claude-`).

## How it works

| Hook | What it does |
|---|---|
| `SessionStart` | Injects the project brief, open tasks, recent sessions, hot files and notes; records device and git state. |
| `UserPromptSubmit` | Stores the prompt and injects matching memory (full-text search, no LLM, a few ms). |
| `PostToolUse` | Queues the tool call. No network, returns immediately. |
| `Stop` | Queues a summary of the turn. |

A detached background process drains the queue: the LLM decides whether a tool call is worth remembering and writes
a structured observation (title, narrative, facts, concepts, files). At the end of each turn it writes a summary, and
every `briefEvery` new records it rewrites the project brief. If the LLM is unreachable, items wait in the queue.

**Gaming:** a local model and a game fight over the same GPU. While a game runs (anything under Steam, Epic, Xbox,
EA, GOG, Riot or Ubisoft game folders, plus whatever you list in `busyProcesses`), the queue waits and the Ollama
models are unloaded; it drains once the game closes. `node "$OM" busy` shows what is detected.

### Tools Claude gets (MCP)

| Tool | Use |
|---|---|
| `search`, `timeline`, `get_observations` | Recall: compact index first, details only for chosen ids |
| `project_context` | The start-of-session brief of any project |
| `task_add`, `task_update`, `items_list` | Durable to-dos (`todo → doing → blocked → done / cancelled`) with history |
| `note_add` (`save_memory` alias) | Decisions, conventions, gotchas, preferences |

Ids: `123` observation, `S45` session summary, `I7` note or task.

## Web viewer

`http://127.0.0.1:37800` (started automatically in local mode; or run `cli serve`). Log in with the admin token.

Sections: **Progress** (counters, activity, open tasks, latest sessions, machines), **Projects** (brief, tasks, notes,
recent sessions, most-edited files, branches), **Timeline** (everything by day, filterable), **Tasks** (board),
**Notes**, **Search**, **Sessions** (prompt by prompt). Any record opens in a side panel with its metadata;
notes and tasks can be edited there.

Security: HttpOnly + SameSite=Strict session cookie (30 days), origin check on writes, strict CSP, login rate limit.
Lost the token? `cli token reset` prints a new one and logs every browser out. To reach it from other devices,
put it behind an HTTPS reverse proxy rather than exposing the port.

## Sharing memory between machines

One machine runs the server; the others push their records to it and read from it.

```bash
# server
node "$OM" serve --host 0.0.0.0           # or a systemd service; `token init` for the web login
node "$OM" device add laptop              # prints a device key once

# each client (the key is read from stdin, so it never lands in shell history)
node "$OM" remote connect --url http://server:37800 --name laptop < keyfile
```

Clients keep writing to their own database (an outbox), compress with their own LLM, and push new rows after each
drain. Reads, notes and tasks go to the server; if it is unreachable they fall back to the local copy and sync later.
`remote disconnect` returns to local mode.

## LLM providers

```bash
OM="$(cat ~/.claude-open-mem/plugin-root)/src/cli.mjs"
node "$OM" config set provider auto        # default: local Ollama if it has a chat model, else none
node "$OM" config set model gemma3:12b     # pin a model
node "$OM" config set provider openai      # any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, ...)
node "$OM" config set baseUrl http://localhost:1234/v1
node "$OM" config set provider none        # no LLM: only edits and shell commands, stored raw; no briefs
```

## CLI

```bash
node "$OM" status                 # counts, LLM, mode, claude-mem detection
node "$OM" import                 # import new claude-mem rows (safe to repeat)
node "$OM" search nginx certs     # search from the terminal
node "$OM" brief my-project       # rewrite a project brief now
node "$OM" drain | sync           # process the queue / push to the server now
node "$OM" busy [--unload]        # is a game running? (exit 0 = busy)
node "$OM" serve | token init | token reset | device add|list|remove | remote connect|disconnect
node "$OM" config [set key value]
```

Inside Claude Code you can also ask Claude to use the `open-mem` skill.

## Privacy

- Everything stays in `~/.claude-open-mem/` unless you point `provider` at a remote endpoint or connect a server.
- Secrets are redacted before anything is queued, stored, synced or sent to the LLM: API keys (Anthropic, OpenAI,
  OpenRouter, GitHub, GitLab, AWS, Google, Slack, Stripe, Telegram, Context7), JWTs, bearer tokens, private keys,
  `user:pass@` in URLs and `password=` / `token:`-style assignments. The server redacts again on ingest.
- Wrap anything in `<private>…</private>` in a prompt to keep it out of memory.
- `settings.json` (which can hold a device key) is written with mode 600; tokens and keys are stored only as hashes.
- `node "$OM" redact` re-scans stored memory (useful after upgrading redaction patterns).

## Migrating from claude-mem

The import is automatic and incremental: while both are installed, every session start copies new claude-mem rows.
The claude-mem database is opened read-only and never modified.

```bash
node "$OM" uninstall-claude-mem --dry-run         # preview
node "$OM" uninstall-claude-mem --yes             # final import, uninstall plugin, stop its worker
node "$OM" uninstall-claude-mem --yes --move-data # also rename ~/.claude-mem to ~/.claude-mem.removed-<date>
```

claude-open-mem never deletes claude-mem data.

## Settings (`~/.claude-open-mem/settings.json`)

| Key | Default | Meaning |
|---|---|---|
| `provider` | `auto` | `auto`, `ollama`, `openai`, `none` |
| `model` / `baseUrl` / `apiKey` | empty | Provider details |
| `skipTools` | TodoWrite, AskUserQuestion, … | Tools never recorded |
| `contextObservations` / `contextSummaries` / `contextTasks` | 12 / 3 / 10 | Amount injected at session start |
| `recallOnPrompt` / `recallLimit` | `true` / 5 | Prompt-time recall |
| `briefEvery` | 25 | New records before a project brief is rewritten (0 = never) |
| `excludedProjects` | `[]` | Folder names never recorded |
| `autoImportClaudeMem` | `true` | Import claude-mem at session start |
| `mode` / `serverUrl` / `deviceName` | `local` | Shared mode (set with `remote connect`) |
| `webHost` / `webPort` / `webAutostart` | `127.0.0.1` / 37800 / `true` | Web viewer |
| `maxToolChars` | 6000 | Tool output sent to the LLM |
| `llmWaitHours` | 72 | How long queued calls wait for an LLM that is down before being stored without it |
| `llmKeepAlive` | `30s` | How long Ollama keeps the model loaded after the last call |
| `pauseWhenBusy` | `true` | Pause the queue and unload Ollama models while a game runs |
| `busyProcesses` | `[]` | Exe names (`GTA5.exe`) or folders (`D:\Games\`) that count as a game |
| `busyPaths` / `busyIgnore` | game libraries / launchers | Folders whose programs count as games, and exceptions |

Set `CLAUDE_OPEN_MEM_DATA_DIR` to move the data folder.

## Development

```bash
node --no-warnings --test "test/*.test.mjs"
claude plugin validate .
claude --plugin-dir .   # try the plugin without installing it
```

## License

MIT

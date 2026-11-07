# claude-open-mem

Open, local-first persistent memory for [Claude Code](https://claude.com/claude-code).

claude-open-mem records what happens in your Claude Code sessions, compresses it into searchable observations and session summaries, and hands Claude a compact brief of each project at the start of every session, so it can start working instead of re-exploring the codebase. It is a drop-in alternative to [claude-mem](https://cmem.ai/) and imports your claude-mem history automatically.

**It never spends your Claude plan.** Compression runs on a local LLM through [Ollama](https://ollama.com), on any OpenAI-compatible endpoint you choose, or without any LLM at all.

- Zero dependencies: Node.js ≥ 22.13 built-ins only (`node:sqlite` with FTS5).
- One SQLite file in `~/.claude-open-mem/`, or one shared server for all your machines.
- **Fast session start**: a per-project brief, open tasks, last next steps and hot files, in ~3 KB of context.
- **Prompt-time recall**: each prompt gets the few past records that match it, never the same one twice.
- **Notes and tasks** that Claude creates and updates itself, with a status history, per project and directory.
- **Web viewer**: progress, projects, timeline, task board, notes, search and sessions, protected by an admin token.
- Every record carries reconstruction metadata: machine, working directory, git branch and commit, model, tool, files.
- Automatic, incremental, read-only import from claude-mem; optional claude-mem uninstall.

## Install

Requirements: Claude Code, Node.js ≥ 22.13 on `PATH`, and for the full feature set a GPU for the local LLM (see [GPU and local model](#gpu-and-local-model) below: **read it before installing**).

The installer checks your GPU before installing anything, tells you when there is none, then installs the plugin and runs `setup` (Ollama + the model that fits your GPU, after asking):

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/ZeroLayerDevTeam/open-mem/main/install.ps1 | iex
```

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/ZeroLayerDevTeam/open-mem/main/install.sh | sh
```

Or by hand:

```bash
claude plugin marketplace add ZeroLayerDevTeam/open-mem
claude plugin install open-mem@claude-open-mem
```

Restart Claude Code. On the first session start claude-open-mem:

1. creates `~/.claude-open-mem/` with `settings.json` and `open-mem.db`;
2. generates a random **web admin token and shows it once** in the session: save it in your password manager (only its SHA-256 hash is stored);
3. starts the web viewer on <http://127.0.0.1:37800>;
4. imports your claude-mem database in the background if it finds one (`~/.claude-mem/claude-mem.db`);
5. starts injecting memory for the current project.

The plugin id is `open-mem` (Claude Code reserves plugin names that start with `claude-`). Installed by hand, run `setup` afterwards (the first session also reminds you when no LLM answers): `node "$(cat ~/.claude-open-mem/plugin-root)/src/cli.mjs" setup`.

## GPU and local model

> **Important:** the summaries, project briefs, notes review and semantic search come from a local LLM that runs on your GPU through [Ollama](https://ollama.com). Without a usable GPU open-mem still installs and works, with fewer features.

`setup` detects the GPU, installs Ollama when it is missing (winget on Windows, Homebrew on macOS, Ollama's install script on Linux, which asks for sudo) and downloads the model that fits. It shows the plan and the download size and asks first (`--yes` skips the question, `--model M` picks another model). `check` only shows what it found.

| Usable GPU memory | Chat model | Download | Notes |
|---|---|---|---|
| 11 GB or more | `gemma3:12b` | 8.1 GB | Tested in depth; best observations and summaries |
| 5.5 to 11 GB | `gemma3:4b` | 3.3 GB | Good enough, shorter observations |
| 2 to 5.5 GB | `gemma3:1b` | 0.8 GB | Smallest; rougher observations |
| No usable GPU | none | | See below |

Every tier also gets `embeddinggemma` (0.6 GB) for semantic search.

How the GPU is found: NVIDIA through `nvidia-smi`; any card on Windows through the display adapters in the registry (WMI reports at most 4 GB, so it is not used); AMD on Linux through amdgpu's `mem_info_vram_total`; Apple Silicon counts two thirds of its unified memory. Integrated graphics (Intel UHD/Iris Xe) and virtual display adapters do not count; Intel Arc does.

No usable GPU (a typical office laptop) leaves these options, `setup` lists them instead of installing anything:

- **No LLM:** tool calls are stored as they are and full-text search works; no summaries, briefs or semantic search.
- **Shared server:** point this machine at an open-mem server on a machine with a GPU (`remote connect`, see [Sharing memory between machines](#sharing-memory-between-machines)).
- **OpenAI-compatible endpoint:** `config set provider openai`, plus `baseUrl`, `model` and `apiKey`.
- **CPU:** `setup --cpu` installs `gemma3:1b` on the CPU. It works, but each record takes many seconds and the CPU stays busy while the queue drains.

The model shares the GPU with games: while one runs the queue waits and the model is unloaded (see Gaming below).

### Sharing the GPU with other work

A local model also competes with other GPU work: model training, another app's models in the same Ollama, a render. open-mem only takes what is left over, and never unloads a model it did not load:

- **GPU budget** (`gpuBudget`, needs `nvidia-smi`): before every call, open-mem checks that its model fits in the free video memory minus `OLLAMA_GPU_OVERHEAD` and `gpuReserveMb` (1536 MiB), counting its own loaded models as free. It also waits when loading its model would push another app's model out of Ollama (`OLLAMA_MAX_LOADED_MODELS`, Ollama's default is 3 per GPU). Both variables are read from the environment, and on Windows from the user's environment in the registry.
- **Smaller models** (`fallbackModels`, e.g. `["gemma3:4b"]`, installed with `ollama pull`): used instead of `model` when it does not fit, while another app has a model loaded in Ollama, or while more than `backlogItems` (500) wait in the queue, to catch up faster.
- **Marker files** (`busyFiles`, default `~/.gpu-busy`): while a file listed there, or any file inside a listed folder, exists, nothing goes to the local Ollama and open-mem frees its own models. A job writes one before it reserves the GPU and removes it when it ends. A JSON marker with `stale_after_s` (and optionally `heartbeat`, an ISO time) only counts while its heartbeat or modification time is that fresh, so a crashed job does not block the queue; `owner` and `phase` show as the reason.
- **Manual pause:** `node "$OM" pause [--hours N] [reason]` holds the queue (and closes the GPU guard) until `node "$OM" resume`.
- A timeout means the GPU is busy elsewhere: the item keeps its attempts and the queue waits 2 minutes before the next call.

The queue only ever waits: nothing is dropped. The web viewer's Progress page shows each machine's queue and why it waits (on a shared server, as reported by each client), and records land on the day they were captured once processed.

## How it works

| Hook | What it does |
|---|---|
| `SessionStart` | Injects the project brief, open tasks, recent sessions, hot files and notes; records device and git state. Warns when the repo sits on a merged branch or one not merged yet; the first session of the day (from 05:00) also gets a recap of the last working session across every project. |
| `UserPromptSubmit` | Stores the prompt and injects matching memory (full-text search, no LLM, a few ms). |
| `PostToolUse` | Queues the tool call. No network, returns immediately. |
| `Stop` | Queues a summary of the turn. |

A detached background process drains the queue: the LLM decides whether a tool call is worth remembering and writes a structured observation (title, narrative, facts, concepts, files). At the end of each turn it writes a summary, and every `briefEvery` new records it rewrites the project brief. If the LLM is unreachable, items wait in the queue: open-mem starts a local Ollama that is installed but not running (`ollamaAutostart`, Windows and macOS, at most every 10 minutes), and every session start warns while it stays down. Only after `llmWaitHours` of downtime counted while the machine is in use (gaps between drains longer than 15 minutes, such as a night with the machine off, do not count) is the queue stored without the LLM.

**Gaming:** a local model and a game fight over the same GPU. While a game runs (anything under Steam, Epic, Xbox, EA, GOG, Riot or Ubisoft game folders, plus whatever you list in `busyProcesses`), the queue waits and open-mem's Ollama models are unloaded; it drains once the game closes. `node "$OM" busy` shows what is detected.

**Semantic search:** after each drain, new records get an embedding from Ollama (`embedModel`, default `embeddinggemma`; `ollama pull embeddinggemma`). Searches merge full-text and vector results, so a search finds records that say the same thing in other words. Without the model, during a game, or when Ollama is down, search is full-text only.

**Notes review:** when a project's notes change, the LLM checks them for contradictions, outdated facts and duplicates (at most every `notesReviewHours`). Its findings appear at session start and on the project page; nothing is changed automatically.

**Repeated mistakes:** once a day per project with new bug fixes, the LLM looks for mistakes fixed in two or more sessions and proposes one rule for each, to copy into the project's known-mistakes list. They appear on the project page only, so they cost Claude no context.

**Recall that learns:** prompt recall notes whether the session then used what it showed (fetched the record, or read or edited one of its files). A record shown in `recallMuteAfter` sessions and never used stops being recalled. `status` shows how much recall gets used.

**Stale tasks:** open tasks untouched for 14 days are marked on the task board.

**Projects:** a project is the name of the folder Claude Code was opened in (not the full path, not the machine). Notes, tasks, recall and the session brief only show records of that project, so to share memory across machines or sessions, open Claude Code in folders with the same name: `G:\Work` on one PC and `~/Work` on a server share it, `~/Work/app` is a separate project `app`. Records of other projects stay reachable through `search` without a project filter.

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

Sections:

- **Progress**: task counters, a year of activity, open tasks, latest sessions, active projects and machines.
- **Projects**: a sortable, filterable table; each project has its brief, open tasks, recent session summaries, notes, notes to check, most-edited files, branches and a Markdown export.
- **Timeline**: everything by day, filtered by project, machine, kind of record and an "up to" date.
- **Sessions**: every conversation, including the ones imported from claude-mem, searchable by prompt text; a session opens prompt by prompt with what was recorded for each.
- **Tasks**: one board per project; drag a card to change its status (on a phone, hold it for a moment first).
- **Notes**: searchable list with an inline editor.
- **Search**: the same hybrid search Claude uses, with kind, project, type and date filters, highlighted matches and an excerpt per result.
- **Local LLM**: live state of the compression model (working, ready, paused for a game, down), the models Ollama holds in memory and how much of each sits on the GPU, GPU memory, load, temperature and power (`nvidia-smi`), generation speed and calls over 24 hours, 7 days or 30 days (charts with a table view), the queue with what is next and what failed, installed models, semantic index coverage and the latest calls with their tokens and timings. Buttons: process the queue now (also during a game), retry failed items, load or free the model, pin the chat model, index everything for semantic search. Every chat call and embedding batch is recorded in `llm_calls` (kept 30 days).

Every list is paged on the server (numbered pages, the page lives in the URL, so back, reload and shared links keep it), and the search box in the top bar (press `/`) works from any page. Any record opens in a side panel with its metadata; notes and tasks are edited there.

The layout adapts from a phone (menu behind a button, stacked tables) to a wide screen. English or Spanish (follows the browser language until you pick one) and an automatic, light or dark theme: both selectors sit at the bottom of the side menu and on the login page, remembered per browser. No framework and no build step: plain ES modules, served gzipped.

Security: HttpOnly + SameSite=Strict session cookie (30 days), origin check on writes, strict CSP, login rate limit. Lost the token? `cli token reset` prints a new one and logs every browser out. To reach it from other devices, put it behind an HTTPS reverse proxy rather than exposing the port.

## Sharing memory between machines

One machine runs the server; the others push their records to it and read from it.

```bash
# server
node "$OM" serve --host 0.0.0.0           # or a systemd service; `token init` for the web login
node "$OM" device add laptop              # prints a device key once

# each client (the key is read from stdin, so it never lands in shell history)
node "$OM" remote connect --url http://server:37800 --name laptop < keyfile
```

Clients keep writing to their own database (an outbox), compress with their own LLM, and push new rows after each drain and every 2 minutes during a long one. Reads, notes and tasks go to the server; if it is unreachable they fall back to the local copy and sync later. `remote disconnect` returns to local mode.

### A server without a GPU

An always-on small server (a Raspberry Pi) can hold the memory while another machine lends its GPU. That machine stays a normal client: it compresses its own sessions with its own Ollama and pauses for games as usual. What runs on the server (embeddings, notes review, search queries) reaches its Ollama through `cli guard`:

```bash
# on the machine with the GPU: its next session start runs the guard (or run `node "$OM" guard` now)
node "$OM" config set guardAllow 192.168.0.10            # the server's address
# on the server
node "$OM" config set baseUrl http://192.168.0.20:11435  # the machine with the GPU
```

Ollama stays on loopback: the guard is the only way in, only for the listed addresses and only for the calls a server needs (never pull or delete). While a game runs, a marker file is live or the queue is paused by hand, it answers 503, cuts the calls in flight and unloads open-mem's models (its own and those the server used, never another app's), within `guardPollSeconds`. A call whose model does not fit in the GPU budget gets 503 too. The server reads that as an LLM that is down, so its work waits and search stays full-text. Listing processes costs half a second, so the guard only does it while the server is using the GPU. With the guard stopped the server has no LLM at all: a failure never takes the GPU from a game.

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
node "$OM" drain [--force] | sync # process the queue (--force: even while a game runs or paused by hand) / push to the server now
node "$OM" pause [--hours N] [reason] | resume  # hold the queue and close the GPU guard, until resume or for N hours
node "$OM" busy [--unload]        # is a game running? (exit 0 = busy; --unload frees open-mem's models)
node "$OM" embed [--all]          # compute missing embeddings now (--all: no per-run limit)
node "$OM" review-notes my-project  # check a project's notes for contradictions now
node "$OM" lessons my-project     # look for mistakes fixed in several sessions now
node "$OM" backup [--out FILE] [--keep N]  # consistent copy of the database while it is in use
node "$OM" export [--project P] [--out DIR]  # notes and tasks as Markdown, one file per project
node "$OM" check                  # GPU found and the model it fits (exit 2 = no usable GPU)
node "$OM" setup [--yes] [--model M] [--cpu]  # install Ollama and the model that fits the GPU
node "$OM" serve | token init | token reset | device add|list|remove | remote connect|disconnect
node "$OM" config [set key value]
```

Inside Claude Code you can also ask Claude to use the `open-mem` skill.

## Privacy

- Everything stays in `~/.claude-open-mem/` unless you point `provider` at a remote endpoint or connect a server.
- Secrets are redacted before anything is queued, stored, synced or sent to the LLM: API keys (Anthropic, OpenAI, OpenRouter, GitHub, GitLab, AWS, Google, Slack, Stripe, Telegram, Context7), JWTs, bearer tokens, private keys, `user:pass@` in URLs and `password=` / `token:`-style assignments. The server redacts again on ingest.
- Wrap anything in `<private>…</private>` in a prompt to keep it out of memory.
- `settings.json` (which can hold a device key) is written with mode 600; tokens and keys are stored only as hashes.
- `node "$OM" redact` re-scans stored memory (useful after upgrading redaction patterns).

## Migrating from claude-mem

The import is automatic and incremental: while both are installed, every session start copies new claude-mem rows. The claude-mem database is opened read-only and never modified.

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
| `recallMuteAfter` | 5 | Stop recalling a record shown in this many sessions that never used it (0 = never) |
| `briefEvery` | 25 | New records before a project brief is rewritten (0 = never) |
| `excludedProjects` | `[]` | Folder names never recorded |
| `autoImportClaudeMem` | `true` | Import claude-mem at session start |
| `mode` / `serverUrl` / `deviceName` | `local` | Shared mode (set with `remote connect`) |
| `webHost` / `webPort` / `webAutostart` | `127.0.0.1` / 37800 / `true` | Web viewer |
| `maxToolChars` | 6000 | Tool output sent to the LLM |
| `llmWaitHours` | 72 | Hours of downtime while the machine is in use before queued calls are stored without the LLM (pauses never count) |
| `ollamaAutostart` | `true` | Start a local Ollama that does not answer (Windows, macOS; loopback `baseUrl` only), at most every 10 minutes |
| `fallbackModels` / `backlogItems` | `[]` / 500 | Smaller chat models used when `model` does not fit, while another app has a model loaded, or while more than `backlogItems` wait |
| `gpuBudget` / `gpuReserveMb` | `true` / 1536 | Send work to the local Ollama only when its model fits in free video memory minus `OLLAMA_GPU_OVERHEAD` and this reserve, without pushing another app's model out |
| `busyFiles` | `["~/.gpu-busy"]` | Marker files or folders: while one exists, the local Ollama gets nothing and open-mem frees its own models |
| `llmKeepAlive` | `10m` | How long Ollama keeps the model loaded after the last call |
| `pauseWhenBusy` | `true` | Pause the queue and unload open-mem's Ollama models while a game runs |
| `busyProcesses` | `[]` | Exe names (`GTA5.exe`) or folders (`D:\Games\`) that count as a game |
| `busyPaths` / `busyIgnore` | game libraries / launchers | Folders whose programs count as games, and exceptions |
| `branchWarning` / `dailyRecap` | `true` / `true` | Branch warning and first-session-of-the-day recap at session start |
| `embedModel` / `embedPerDrain` | `embeddinggemma` / 2000 | Ollama embedding model (`''` = full-text only) and records embedded per drain |
| `notesReview` / `notesReviewHours` | `true` / 12 | LLM review of changed notes, at most this often per project |
| `lessonsReview` | `true` | Daily LLM search for mistakes fixed in several sessions (web project page only) |
| `serveDrainMinutes` | 10 | `cli serve` drains the queue and runs the upkeep this often (0 = never) |
| `wakeMac` | `""` | MAC of the machine that runs Ollama when it is not the server: `cli serve` wakes it (Wake-on-LAN) when queued work waits for the LLM, then drains once the LLM answers (`""` = never) |
| `wakeBroadcast` | `255.255.255.255` | Broadcast address for the magic packet (e.g. `192.168.0.255`) |
| `wakeOffMinutes` | 10 | Quiet minutes after the last LLM call before `wakeOffCommand` runs; only a machine the server woke is turned off |
| `wakeOffCommand` | `""` | Shell command that turns that machine off (e.g. over SSH). Exit 0 = turned off, 3 = in use, left on; anything else is retried after another quiet period |
| `guardAllow` / `guardPort` | `[]` / 11435 | Addresses `cli guard` lets through to this machine's Ollama, and its port (`[]` = no guard) |
| `guardPollSeconds` | 10 | How often the guard looks for a game while a server is using the GPU |

Set `CLAUDE_OPEN_MEM_DATA_DIR` to move the data folder.

## Development

```bash
node --no-warnings --test "test/*.test.mjs"
claude plugin validate .
claude --plugin-dir .   # try the plugin without installing it
```

## License

MIT

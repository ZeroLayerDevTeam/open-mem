# Changelog

## 0.5.5

- Prompt recall and full-text search with a project or date filter no longer stall: SQLite picked the project index as the outer loop and ran the MATCH once per row of the project, about 20 s on a 50k-record memory, so the `UserPromptSubmit` hook hit its 15 s timeout and the recall was thrown away. Filter columns now carry a unary `+` when there is a MATCH, so the FTS index drives the query (about 70 ms, same results).

## 0.5.4

- GPU guard for a shared server without a GPU (`cli guard`, `guardAllow`, `guardPort`, `guardPollSeconds`, new `src/guard.mjs`). The machine with the GPU lets the listed addresses reach its Ollama through a small proxy, limited to the calls a server needs. While a game runs it answers 503, cuts the calls in flight and unloads the models, so a server that cannot see the game still leaves the GPU alone. Ollama stays on loopback, and session start runs the guard once `guardAllow` is set.

## 0.5.3

- Wake-on-LAN for a shared server whose Ollama runs on another machine (`wakeMac`, `wakeBroadcast`, `wakeOffMinutes`, `wakeOffCommand`, new `src/wake.mjs`). Every 30 s `cli serve` checks: queued work and the LLM not answering sends a magic packet (again after 5 minutes if still asleep); once the LLM answers it starts a drain; `wakeOffMinutes` after the last LLM call it runs `wakeOffCommand`. Only a machine the server woke is turned off, and the command decides whether it is in use (exit 3 leaves it on).

## 0.5.2

- Local LLM page on a server without an NVIDIA GPU (Ollama on another machine, reached through a tunnel): the machine that runs Ollama sends its GPU (memory, load, temperature, power) after each queue run, at most once a minute (`POST /api/gpu`, device key only). The GPU panel shows it with the machine name and its age, and a note below says the GPU is on that other machine. Reports older than a week are dropped. The nvidia-smi code moved to `src/gpu.mjs`.

## 0.5.1

- Local LLM page: `nvidia-smi` is also looked up where the NVIDIA driver installs it when it is not on PATH (`System32`, `Program Files\NVIDIA Corporation\NVSMI`, `/usr/lib/wsl/lib`). The GPU panel tells "nvidia-smi not found" apart from "nvidia-smi failed" (and shows its error, e.g. driver not loaded); a missing one is looked for again every minute instead of every poll.
- Local LLM page: spacing between the panels was missing (the margin rule only matched direct children of `main`).

## 0.5.0

- Web viewer redesign: responsive layout from phone to wide screen (off-canvas menu, stacked tables, no horizontal scroll), a search box in the top bar on every page (`/` focuses it), record side panel as a modal dialog, toasts after saving, skeletons while loading, a year-long activity map, project paths shown from the project folder.
- Server-side pagination with numbered pages for the timeline, sessions, notes and search (`page`, `size`; responses carry `total`). The page and filters live in the URL.
- Sessions are built from the records themselves, so the sessions imported from claude-mem are listed and open prompt by prompt (before, only sessions started with open-mem appeared). A session that touched several projects counts for each.
- Search page: kind, project, type and date filters, highlighted matches, an excerpt per result, recent searches. Hybrid search pages rank the same fused pool, so page 2 continues page 1 (up to 100 results, plain full-text after that). New `searchCount` in `store.mjs`.
- New read routes: `/api/facets` (filter menus), `/api/items` (paged notes and tasks with full-text filter), `/api/find` (paged search); `/api/feed` and `/api/sessions` now page by number.
- Speed: schema v4 adds indexes for sessions, the timeline and machines (the machines list went from 180 ms to 6 ms on a 48k-record database); timeline pages read only (kind, id, time) before loading the page's rows (about 5 ms for any page); JSON and static files over 1 KB are gzipped.

- Web: **Local LLM** page (`#/llm`, refreshes every 5 s while visible). State of the compression model (working, ready, paused for a game, not answering), models in Ollama's memory with their GPU share and when they are freed, GPU memory, load, temperature and power from `nvidia-smi`, generation speed and calls per hour or day over 24 hours, 7 days or 30 days (HTML column charts with tooltips and a table view), the queue (next items with their tool and file or command, failed items with the error), installed models, semantic index coverage and the latest 25 calls with tokens, speed, load time and duration.
- Actions on that page (admin only): process the queue now, also while a game runs (`cli drain --force`); retry failed items; load the chat model (kept 10 minutes) or free Ollama's memory; pin the chat model (`settings.model`, or back to automatic); index every record for semantic search (`cli embed --all` in the background). Routes: `GET /api/engine?hours=24|168|720`, `POST /api/engine/drain|retry|load|unload|model|embed`.
- Every LLM call is measured: schema v5 adds `llm_calls` (task, model, ok, tokens in and out, load, prompt, generation and total time, error), filled by `completeJson` and by each embedding batch, pruned after 30 days. Calls whose reply is not JSON are recorded as failed with their timings.

## 0.4.0

- Web viewer in English and Spanish (`web/i18n.js`): follows the browser language until one is picked; dates and numbers use the matching locale. A test checks that every UI string has a translation.
- Theme selector: automatic (system), light or dark. Language and theme are remembered per browser.
- Web task boards: cards move with pointer events instead of HTML5 drag and drop, which never fired on touch screens and stalled in some browsers. On a phone, hold a card for a moment, then drag it. The drag handlers are bound once instead of once per page render.

## 0.3.1

- Fix: a newline literal in `cli.mjs` stopped the CLI and the server from starting in 0.3.0. A test now parses every source file.

## 0.3.0

- Semantic search: records get Ollama embeddings (`embedModel`, default `embeddinggemma`) after each drain; search merges full-text and vector results (reciprocal rank fusion). Falls back to full-text while a game runs, before any vector exists, or when Ollama does not answer. `cli embed [--all]` backfills. Schema v3 (`embeddings` table, vectors dropped by triggers when their record changes or is deleted).
- Session start warns when the repo is on a branch already merged into the default one, or on one with unmerged commits (`branchWarning`).
- First session of the day (from 05:00): a recap of the last working session across every project (`dailyRecap`).
- Notes review: the LLM flags contradictory, outdated or duplicated notes of a project after they change (`notesReview`, `notesReviewHours`, `cli review-notes`). Shown at session start and on the project page.
- Web: the Tasks page shows one board per project, and cards are dragged between columns to change their status.
- Markdown export of a project's notes and tasks: `cli export`, `/api/export`, link on the project page.
- `cli serve` drains the queue and runs the upkeep every `serveDrainMinutes` (default 10).

## 0.2.5

- Game guard: while a game runs (`busyProcesses` exe names or folders, `busyPaths` game library folders such as `steamapps/common`), the queue waits and the Ollama models are unloaded, so the local LLM takes no VRAM or GPU time from it. `busyIgnore` skips launchers; `pauseWhenBusy false` turns it off.
- Ollama requests send `keep_alive` (`llmKeepAlive`, default `30s`): the model leaves the GPU soon after a drain instead of staying loaded for 5 minutes.
- `cli busy [--unload]`: exit 0 while busy, for scripts (e.g. closing a tunnel that lends this GPU to a server).

## 0.2.4

- Plugin icon (512 px PNG + SVG source in `.claude-plugin/`); the web viewer uses the same mark.

## 0.2.3

- No data loss while the LLM is down: once an LLM has been seen, queue items wait for it (`llmWaitHours`, default 72) instead of going through the no-LLM path, which drops reads and searches.
- An item the LLM keeps failing on is stored without the LLM instead of being marked failed.
- Shared mode: a 502/503 from the server (restarting behind a proxy) falls back to the local database like a network error, so notes and tasks written meanwhile are pushed later instead of failing.

## 0.2.2

- Login rate limit keyed on the real client behind a reverse proxy (X-Real-IP / X-Forwarded-For, trusted only from private peers), so one attacker cannot lock everyone out; stale entries pruned.

## 0.2.1

- Data folder created owner-only (700).
- Push progress drawn only on a terminal.

## 0.2.0

- **Faster session start**: per-project brief written by the local LLM, open tasks, last next steps, most-edited files and notes, in about 3 KB. Usage rules for Claude included.
- **Prompt-time recall**: matching records injected on each prompt (FTS, no LLM), never repeated within a session.
- **Notes and tasks** (`I<n>` ids) with status history, priority, due date, tags, project and directory. New MCP tools: `project_context`, `note_add`, `task_add`, `task_update`, `items_list` (`save_memory` kept as alias).
- **Web viewer** (`cli serve`, autostarted on 127.0.0.1:37800): progress, projects, timeline, task board, notes, search, sessions, record panel with editing. Admin token generated at install and shown once; only its hash is kept.
- **Shared mode**: one server, many machines. Device keys, local outbox + push, remote reads with local fallback.
- **Metadata** on every record: device, cwd, git branch and commit, model, tool use id, files per summary.
- Schema v2 with automatic migration; FTS update triggers limited to text columns.
- All docs in English.

## 0.1.2

- MCP server declared in `plugin.json` (no project `.mcp.json`).

## 0.1.1

- claude-mem uninstall covers every scope and keeps plugin data.

## 0.1.0

- First release: hooks, queue + drainer, MCP search/timeline/get_observations/save_memory, claude-mem import, CLI, secret redaction.

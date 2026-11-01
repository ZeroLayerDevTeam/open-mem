# Changelog

## 0.3.1

- Fix: a newline literal in `cli.mjs` stopped the CLI and the server from starting in 0.3.0. A test now parses every
  source file.

## 0.3.0

- Semantic search: records get Ollama embeddings (`embedModel`, default `embeddinggemma`) after each drain; search
  merges full-text and vector results (reciprocal rank fusion). Falls back to full-text while a game runs, before
  any vector exists, or when Ollama does not answer. `cli embed [--all]` backfills. Schema v3 (`embeddings` table,
  vectors dropped by triggers when their record changes or is deleted).
- Session start warns when the repo is on a branch already merged into the default one, or on one with unmerged
  commits (`branchWarning`).
- First session of the day (from 05:00): a recap of the last working session across every project (`dailyRecap`).
- Notes review: the LLM flags contradictory, outdated or duplicated notes of a project after they change
  (`notesReview`, `notesReviewHours`, `cli review-notes`). Shown at session start and on the project page.
- Web: the Tasks page shows one board per project, and cards are dragged between columns to change their status.
- Markdown export of a project's notes and tasks: `cli export`, `/api/export`, link on the project page.
- `cli serve` drains the queue and runs the upkeep every `serveDrainMinutes` (default 10).

## 0.2.5

- Game guard: while a game runs (`busyProcesses` exe names or folders, `busyPaths` game library folders such as
  `steamapps/common`), the queue waits and the Ollama models are unloaded, so the local LLM takes no VRAM or GPU
  time from it. `busyIgnore` skips launchers; `pauseWhenBusy false` turns it off.
- Ollama requests send `keep_alive` (`llmKeepAlive`, default `30s`): the model leaves the GPU soon after a drain
  instead of staying loaded for 5 minutes.
- `cli busy [--unload]`: exit 0 while busy, for scripts (e.g. closing a tunnel that lends this GPU to a server).

## 0.2.4

- Plugin icon (512 px PNG + SVG source in `.claude-plugin/`); the web viewer uses the same mark.

## 0.2.3

- No data loss while the LLM is down: once an LLM has been seen, queue items wait for it (`llmWaitHours`, default
  72) instead of going through the no-LLM path, which drops reads and searches.
- An item the LLM keeps failing on is stored without the LLM instead of being marked failed.
- Shared mode: a 502/503 from the server (restarting behind a proxy) falls back to the local database like a network
  error, so notes and tasks written meanwhile are pushed later instead of failing.

## 0.2.2

- Login rate limit keyed on the real client behind a reverse proxy (X-Real-IP / X-Forwarded-For, trusted only from
  private peers), so one attacker cannot lock everyone out; stale entries pruned.

## 0.2.1

- Data folder created owner-only (700).
- Push progress drawn only on a terminal.

## 0.2.0

- **Faster session start**: per-project brief written by the local LLM, open tasks, last next steps, most-edited
  files and notes, in about 3 KB. Usage rules for Claude included.
- **Prompt-time recall**: matching records injected on each prompt (FTS, no LLM), never repeated within a session.
- **Notes and tasks** (`I<n>` ids) with status history, priority, due date, tags, project and directory.
  New MCP tools: `project_context`, `note_add`, `task_add`, `task_update`, `items_list` (`save_memory` kept as alias).
- **Web viewer** (`cli serve`, autostarted on 127.0.0.1:37800): progress, projects, timeline, task board, notes,
  search, sessions, record panel with editing. Admin token generated at install and shown once; only its hash is kept.
- **Shared mode**: one server, many machines. Device keys, local outbox + push, remote reads with local fallback.
- **Metadata** on every record: device, cwd, git branch and commit, model, tool use id, files per summary.
- Schema v2 with automatic migration; FTS update triggers limited to text columns.
- All docs in English.

## 0.1.2

- MCP server declared in `plugin.json` (no project `.mcp.json`).

## 0.1.1

- claude-mem uninstall covers every scope and keeps plugin data.

## 0.1.0

- First release: hooks, queue + drainer, MCP search/timeline/get_observations/save_memory, claude-mem import, CLI,
  secret redaction.

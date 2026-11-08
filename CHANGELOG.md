# Changelog

## 0.9.3

- After an LLM timeout the queue waits 15 s, then 30 s, 60 s and at most 2 minutes for the timeouts in a row, and starts over after an answer. Before, every timeout paused it 2 minutes, even when Ollama was free again at once. A model failure still waits 2 minutes.
- Plugin updates reach the open sessions without a restart: a hook run from an older version's folder of the plugin cache hands itself over to the newest version installed next to it. The MCP server of an open session keeps its version until the session restarts.

## 0.9.2

- A draining client reports its queue to the shared server every 30 seconds (the numbers only; records are still pushed every 2 minutes), so the web viewer is at most that far behind.
- Web viewer: each machine's queue shows how old its last report is and when the next one is due, counting every second, and "Queues on other machines" has its own Refresh button.
- Ollama calls ask for the context the model is already loaded with when it is larger than 8192 (another app on the same Ollama, such as the context compactor, loads it with 24576). Before, Ollama waited to reload the model until that app let it go, which could take hours, and every call timed out after 120 s. Prompts are still clipped to 8192.
- Tests no longer depend on the machine they run on: a game seen by one test, or a busy real GPU, made others fail now and then.

## 0.9.1

- `llmParallel` (default 1): queue items sent to the LLM at the same time. With Ollama started with `OLLAMA_NUM_PARALLEL` of at least that many, the GPU writes several replies together, so a long queue drains several times faster with the same model. A turn summary still waits for the observations of its turn, and a pause or an LLM failure stops every worker.
- A client reports its queue to the shared server every 2 minutes while it drains, not only when the queue is empty: the web viewer showed an old report (often an empty queue) during long runs.
- An item the model loops on (Ollama answers `prediction aborted, token repeat limit reached`) is stored without the LLM at once. Before, it paused the whole queue for 2 minutes three times, and a manual drain stopped.
- Web viewer: the LLM page shows the queues the other machines report, and Progress and LLM have a Refresh button.

## 0.9.0

- `cli backfill --from T --to T [--dir D]... [--dry-run]`: queues again, from Claude Code's transcripts, what a time window lost while the LLM was down: observations stored raw (upgraded in place, same id and time, once the LLM answers), calls the no-LLM path dropped (reads, searches, MCP calls) and turn summaries without a model or missing (each with the final message of its own turn). Records keep their capture time, nothing already in memory with the LLM or in the queue is queued twice (by tool_use_id), failed calls and skipped tools are left out, and a session resumed from another account is read from its most complete transcript. It only queues: the drainer runs these after what already waits, under the same pause and GPU rules. `--dir` takes config folders, projects folders or a folder of accounts (default `CLAUDE_CONFIG_DIR` and `~/.claude`).
- A shared server takes an observation a client pushes again (an upgraded one) as a replacement of its copy, keeping its id, instead of ignoring it.

## 0.8.0

- README and the installers (`install.ps1`, `install.sh`) install from the new GitHub repo `ZeroLayerDevTeam/open-mem`.
- open-mem never unloads another app's Ollama models any more. A paused drain (every hook, every few seconds), the GPU guard (every `guardPollSeconds`), `cli busy --unload` and the web viewer's "Free the memory" button unloaded every model Ollama had loaded, so a job sharing that Ollama (a dataset build) reloaded its model on almost every call. They now unload only open-mem's models (`model`, `fallbackModels`, `embedModel`, the picked model and, for the guard, the models the server used).
- A short Ollama outage no longer sends a big queue through the lossy no-LLM path. Items older than `llmWaitHours` were stored without the LLM (only edits and commands, reads dropped) as soon as Ollama stopped answering. Now the queue waits for the LLM, and only after `llmWaitHours` of downtime counted while the machine is in use (gaps of more than 15 minutes between drains do not count, nor do pauses) is it stored without it.
- GPU budget for a local Ollama (`gpuBudget`, `gpuReserveMb` 1536): before every call, open-mem checks with `nvidia-smi` that its model fits in the free video memory minus `OLLAMA_GPU_OVERHEAD` and the reserve, and waits when loading it would push another app's model out of Ollama (`OLLAMA_MAX_LOADED_MODELS`). `fallbackModels` (e.g. `gemma3:4b`) are used when the main model does not fit, while another app has a model loaded, or while more than `backlogItems` (500) wait. The GPU guard refuses (503) a call whose model does not fit.
- Marker files (`busyFiles`, default `~/.gpu-busy`): while one exists, the local Ollama gets nothing, open-mem frees its own models and the guard closes. JSON markers with `stale_after_s` count only while their heartbeat is fresh.
- `cli pause [--hours N] [reason]` and `cli resume`: hold the queue by hand. `drain --force` (and the web button) overrides a game or a manual pause, never a marker or the GPU budget.
- A local Ollama that is not running (connection refused, never a busy one that answers late) is started (`ollamaAutostart`, at most every 10 minutes): on Windows the desktop app through explorer.exe so it gets the user's current environment, or `ollama serve` with the user's `OLLAMA_*` variables from the registry; on macOS the app. Every session start warns while the LLM stays down. A PC shut down with Ollama not set to start at login left the queue waiting for four and a half days without a word.
- The Progress page shows each machine's queue: how many items wait since when, and why (paused by hand, a marker, a game, GPU memory, Ollama full, LLM slow, LLM down). Clients of a shared server report it to the server (`/api/client`, with their GPU) at most once a minute and at once when the pause changes, so a delay in the activity chart no longer reads as missing work. The LLM page shows the same reason.
- A timeout keeps the item and its attempts and the queue waits 2 minutes before the next call, instead of retrying on every tool call while the GPU is busy elsewhere. An Ollama error (HTTP 500, such as a model that fails to load) also waits 2 minutes between attempts instead of burning them in a row and storing the item without the LLM; a 502/503 (the GPU guard closed) costs no attempt. A reply without a title counts as a failed attempt instead of dropping the item.
- While a marker or a manual pause holds, drainers do not even ask Ollama (nor start it), the GPU guard closes on the next request instead of the next poll, briefs wait too, and search stays full-text.
- Replies cut at the token limit are salvaged (the members written before the cut) instead of failing with "LLM reply has no JSON object"; Ollama calls cap the reply at 1536 tokens and summary prompts clip the observation list, so prompt and reply stay inside the 8k context.
- Embeddings check whether to stop before each batch, not only after the first one.
- Less log noise: "drain handled 0 items" is gone, pauses and LLM outages are logged when they start or change and then every 10 minutes, and `open-mem.log` rotates to `open-mem.log.1` past 5 MB.
- `EpicOnlineServicesUserHelper.exe` no longer counts as a game (`busyIgnore`).
- README explains that a project is the name of the folder Claude Code runs in, so memory is shared between folders with the same name.

## 0.7.1

- A scheduled drain of `serve` that outlasted `serveDrainMinutes` no longer overlaps with the next one: `serve` drains inside its own process and the lock took its own pid for a dead process, so the next tick stole it and repeated the LLM work on the same GPU.
- The daily lessons review skips projects whose bug fixes come from a single session: a lesson needs two sessions, so that LLM call could only be wasted.

## 0.7.0

- `cli setup [--yes] [--model M] [--cpu]`: detects the GPU (NVIDIA through nvidia-smi, any card on Windows through the registry, AMD on Linux through amdgpu, Apple Silicon unified memory), installs Ollama when missing (winget, Homebrew or Ollama's script, after asking) and pulls the model that fits: 11 GB or more `gemma3:12b`, 5.5 to 11 GB `gemma3:4b`, 2 to 5.5 GB `gemma3:1b`, plus `embeddinggemma`. Without a usable GPU it installs nothing and lists the alternatives (no LLM, shared server, OpenAI-compatible endpoint, `--cpu`).
- `cli check`: the GPU found and the model it fits (exit 2 = no usable GPU).
- `install.ps1` (Windows) and `install.sh` (Linux, macOS): check Node.js and Claude Code, warn before installing when there is no usable GPU, install the plugin and run `setup`.
- The first session on a machine where no LLM answers shows how to run `setup` (once, to the user only, not in Claude's context).
- README: new section "GPU and local model" (read it before installing).

## 0.6.1

- `cli backup` builds the copy in the data folder and then moves it to `--out`: SQLite cannot lock a file on a network share (SMB/CIFS), so VACUUM INTO straight onto one hung or failed with "database is locked" (the real cause of the failed nightly backup). A failed copy leaves no partial file.

## 0.6.0

- `cli backup [--out FILE] [--keep N]`: a consistent copy of the database while it is in use (VACUUM INTO, which waits for writers through busy_timeout, then `integrity_check` on the copy; a bad copy is removed). Without `--out` it goes to `backups/` in the data folder and keeps the newest N (7). A backup script that ran VACUUM INTO on its own read-only connection failed with "database is locked" while the drainer was writing.
- Recall that learns which records help: prompt recall logs what it showed per session (schema v6, `recall_log`, pruned after 90 days) and marks a record used when the session fetches it (`get_observations`, `timeline`) or reads or edits one of its files. A record shown in `recallMuteAfter` sessions (default 5, 0 = never) and never used is no longer recalled. Recall replies carry each record's files. `status` prints how much recall gets used.
- Repeated mistakes: once a day per project with new bug fixes (`lessonsReview`), the local LLM looks for mistakes fixed in two or more different sessions and proposes one rule each. Shown on the web project page with a copy button, never in Claude's context. `cli lessons <project>` runs it now.
- Web task boards mark open tasks untouched for 14 days as stale.

## 0.5.7

- `config set llmKeepAlive <time>` checks the value before saving it (a Go duration such as `30s`, `10m` or `1h`; a bare number counts seconds and is stored with the unit, so `0` unloads at once and `-1` keeps the model loaded). The help lists it with the 10-minute default.

## 0.5.6

- A client of a shared server pushes every 2 minutes while its queue drains. It only pushed when the queue emptied, so with several sessions keeping the queue full new records never reached the server.
- `llmKeepAlive` defaults to `10m` (was `30s`): the model stays on the GPU between drains instead of being reloaded for each one, which made every drain wait for the load. `pauseWhenBusy` and the GPU guard still unload it when a game starts.

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

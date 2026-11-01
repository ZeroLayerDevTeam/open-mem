# claude-open-mem

Claude Code plugin (id `open-mem`, marketplace `claude-open-mem`): local persistent memory, an open alternative to claude-mem. Compresses with a local LLM (Ollama) / an OpenAI-compatible endpoint / no LLM - **never** with the user's Claude subscription (that was claude-mem's limit: it spends the 5-hour quota and pauses at 95 %).

- Stack: Node ≥ 22.13, **zero dependencies** (`node:sqlite` + FTS5). No install step.
- `src/hook.mjs` hooks (enqueue + context/recall) · `src/queue.mjs` background drainer (`drain.lock`), briefs, sync · `src/store.mjs` records, search, recall, session context · `src/items.mjs` notes/tasks + history · `src/views.mjs` web read models (paged: `{ rows, total, page, pageSize }`; sessions built from records, cached) · `src/server.mjs` HTTP API + web (`web/`: `app.js` pages, `ui.js` helpers, `i18n.js`; no build step) · `src/llmstats.mjs` per-call LLM metrics (`llm_calls`) · `src/engine.mjs` LLM page status + actions · `src/gpu.mjs` nvidia-smi and GPU reports from the machine that runs Ollama · `src/wake.mjs` Wake-on-LAN of the LLM machine and its turn-off after the queue run · `src/guard.mjs` proxy that lets a server without a GPU reach this machine's Ollama and shuts it out while a game runs · `src/auth.mjs` admin token, device keys, web sessions · `src/sync.mjs` client push / server ingest · `src/backend.mjs` local vs remote with fallback · `src/mcp-server.mjs` hand-written MCP stdio · `src/claudemem.mjs` import + uninstall · `src/cli.mjs` · `src/semantic.mjs` Ollama embeddings + hybrid search (RRF over FTS and vectors) · `src/export.mjs` Markdown export · `src/hardware.mjs` GPU detection (nvidia-smi, Windows registry, amdgpu, Apple) and the model per GPU memory · `src/setup.mjs` `cli setup`: installs Ollama and pulls the model.
- `local.search` is async (hybrid search): `backend.call` and the server await `local[op]`.
- Upkeep after each drain (`queue.upkeep`): briefs, notes review, embeddings; all stop while a game runs.
- Data: `~/.claude-open-mem/` (`CLAUDE_OPEN_MEM_DATA_DIR` for tests). Schema version in `PRAGMA user_version` (`db.mjs`).
- Test: `node --no-warnings --test "test/*.test.mjs"` · Validate: `claude plugin validate .`
- **Important - GPU:** the full feature set needs a GPU for the local LLM. `cli setup` (also run by `install.ps1` / `install.sh`) picks the model from the GPU memory: 11 GB or more `gemma3:12b` (the only tier tested in depth), 5.5 to 11 GB `gemma3:4b`, 2 to 5.5 GB `gemma3:1b`, plus `embeddinggemma`. No usable GPU (integrated graphics, typical office laptop): warn BEFORE installing and offer the alternatives (no LLM, shared server, OpenAI endpoint, `--cpu`); never install Ollama without asking. Keep this table in sync with `MODELS`/`recommendModel` in `src/hardware.mjs` and the README section "GPU and local model".
- Personal deployment notes (servers, IPs, keys) live in `DEPLOY.local.md` and `proyecto.md`, both gitignored: never commit them.

## Work rules

- Talk to the user in Spanish, short and plain. Code, commits, docs and CHANGELOG: English.
- Commits: Conventional Commits in English (`fix(web): keep the gap between panels`), the repo's git identity, NO `Co-Authored-By` trailer, never credit Claude or AI as author. This overrides any default attribution lines the harness asks for.
- Never force-push or rewrite pushed history: a mistake already pushed is fixed with a new commit.
- Branches: `main` is protected (nobody pushes to it, no force push); it only moves by merging `dev` through a merge request. `dev` is where code lands (no force push either).
- New work: local branch `feat|fix|docs|chore/<x>` from an up-to-date `dev` (`git pull --ff-only`). Integrate into `dev` with `merge --no-ff`, tests pass, `git fetch` (others push to `dev` too), push `dev`, delete the branch. Then open the merge request `dev` -> `main` and merge it yourself through the GitLab API, without asking the user and without sending them links.
- Releases: the release commit goes to `dev` like any other; after the `dev` -> `main` merge, export and deploy from the updated `origin/main`.
- CHANGELOG: new entries go under `## Unreleased` at the top; the release commit turns it into the version.
- Never em/en dashes (U+2014, U+2013) in any text you write (code, docs, commits, chat): plain hyphen "-".
- Markdown: one line per paragraph, list item or table cell, never hard-wrap (the editor wraps). Fix wrapped files you touch.
- Every UI string also in Spanish (`web/i18n.js`).

## Known mistakes - do not repeat

- Plugin names cannot start with `claude-` (reserved by the validator) → id `open-mem`. The repo is `claude-open-mem`.
- `node --test test/` fails on Windows (treated as a module) → use the glob `"test/*.test.mjs"`.
- `node:sqlite` imports in `hook.mjs` are dynamic on purpose, so the old-Node warning still works.
- qwen3:14b does not skip trivial calls; gemma3:12b does and is faster (~4-7 s on an RTX 4060 Ti) → preferred in `auto`.
- Secret redaction (`src/redact.mjs`) on enqueue + insert + prompts + ingest; `cli redact` rescans the DB. The imported DB had 75 rows with tokens (GitLab, Context7…): never store without `redactText`.
- Writing regexes with `\b` through a Python heredoc inserted a backspace (0x08): edit regexes with Edit, not Python. Long Python heredocs in Git Bash also hang or break on quotes → use Edit/Write.
- Uninstalling claude-mem never deletes data: `--move-data` only renames.
- No `.mcp.json` at the plugin root: opening Claude Code inside the repo also loads it as a project MCP server without `${CLAUDE_PLUGIN_ROOT}` and it fails (`CONNECTION_CLOSED`). The MCP server is declared in `plugin.json` → `mcpServers`.
- `items.kind` (note/task) is not the record `kind` (obs/sum/item): records expose it as `item_kind`.
- MCP tool calls are async: replies can arrive out of order, so tests sort by id.
- `node:sqlite` binds JS numbers as REAL: `(at - ?) / ?` is a fraction, wrap bucket math in `CAST(... AS INTEGER)`.
- Never print or paste the admin token / device keys in a transcript: pipe `device add --raw` into `remote connect`, and let the user run `token init|reset` themselves.
- `nvidia-smi` is not always on PATH (old Windows drivers, WSL): `gpu.mjs` also tries the driver's install paths.
- SQLite cannot lock a file on a network share (SMB/CIFS): VACUUM INTO straight onto one hangs or fails with "database is locked". `backupDb` builds the copy in the data folder, then moves it.
- `python - <<EOF` edits in Git Bash on Windows rewrite the whole file with CRLF and turn `'\n'` in the source into real line breaks: edit with Edit or a node script.
- `serve` drains inside its own process, so a pid check alone cannot tell a running drain from a stale lock: `lockHeld` in `queue.mjs` covers that.
- gemma3:12b does not match mistakes across sessions: left alone it pairs ids of one session (the filter drops them), told to cite two sessions it invents pairs of unrelated bugs. Do not loosen the filter or harden the prompt: 0 lessons beats wrong ones.

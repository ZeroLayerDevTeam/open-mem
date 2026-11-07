# claude-open-mem

Claude Code plugin (id `open-mem`, marketplace `claude-open-mem`): local persistent memory, an open alternative to claude-mem. Compresses with a local LLM (Ollama) / an OpenAI-compatible endpoint / no LLM - **never** with the user's Claude subscription (that was claude-mem's limit: it spends the 5-hour quota and pauses at 95 %).

- Stack: Node ≥ 22.13, **zero dependencies** (`node:sqlite` + FTS5). No install step.
- `src/hook.mjs` hooks (enqueue + context/recall) · `src/queue.mjs` background drainer (`drain.lock`), briefs, sync · `src/store.mjs` records, search, recall, session context · `src/items.mjs` notes/tasks + history · `src/views.mjs` web read models (paged: `{ rows, total, page, pageSize }`; sessions built from records, cached) · `src/server.mjs` HTTP API + web (`web/`: `app.js` pages, `ui.js` helpers, `i18n.js`; no build step) · `src/llmstats.mjs` per-call LLM metrics (`llm_calls`) · `src/engine.mjs` LLM page status + actions · `src/gpu.mjs` nvidia-smi and GPU reports from the machine that runs Ollama · `src/budget.mjs` GPU budget (model that fits the free VRAM, OLLAMA_MAX_LOADED_MODELS), marker files (`busyFiles`), manual pause · `src/wake.mjs` Wake-on-LAN of the LLM machine and its turn-off after the queue run · `src/guard.mjs` proxy that lets a server without a GPU reach this machine's Ollama and shuts it out while a game runs · `src/auth.mjs` admin token, device keys, web sessions · `src/sync.mjs` client push / server ingest · `src/backend.mjs` local vs remote with fallback · `src/mcp-server.mjs` hand-written MCP stdio · `src/claudemem.mjs` import + uninstall · `src/cli.mjs` · `src/semantic.mjs` Ollama embeddings + hybrid search (RRF over FTS and vectors) · `src/export.mjs` Markdown export · `src/hardware.mjs` GPU detection (nvidia-smi, Windows registry, amdgpu, Apple) and the model per GPU memory · `src/setup.mjs` `cli setup`: installs Ollama and pulls the model.
- `local.search` is async (hybrid search): `backend.call` and the server await `local[op]`.
- Upkeep after each drain (`queue.upkeep`): briefs, notes review, embeddings; all stop while paused (game, marker, GPU budget, manual pause).
- Data: `~/.claude-open-mem/` (`CLAUDE_OPEN_MEM_DATA_DIR` for tests). Schema version in `PRAGMA user_version` (`db.mjs`).
- Test: `node --no-warnings --test "test/*.test.mjs"` · Validate: `claude plugin validate .`
- **Important - GPU:** the full feature set needs a GPU for the local LLM. `cli setup` (also run by `install.ps1` / `install.sh`) picks the model from the GPU memory: 11 GB or more `gemma3:12b` (the only tier tested in depth), 5.5 to 11 GB `gemma3:4b`, 2 to 5.5 GB `gemma3:1b`, plus `embeddinggemma`. No usable GPU (integrated graphics, typical office laptop): warn BEFORE installing and offer the alternatives (no LLM, shared server, OpenAI endpoint, `--cpu`); never install Ollama without asking. Keep this table in sync with `MODELS`/`recommendModel` in `src/hardware.mjs` and the README section "GPU and local model".
- Personal deployment notes (servers, IPs, keys) live in `DEPLOY.local.md` and `proyecto.md`, both gitignored: never commit them.

## Work rules

- Talk to the user in Spanish, short and plain. Code, commits, docs and CHANGELOG: English.
- Commits: Conventional Commits in English (`fix(web): keep the gap between panels`), the repo's git identity, NO `Co-Authored-By` trailer, never credit Claude or AI as author. This overrides any default attribution lines the harness asks for.
- Never force-push or rewrite pushed history: a mistake already pushed is fixed with a new commit.
- Repos: `origin` = `gitlab.com/zerolayer/open-mem` (private): all daily work lands here first. `github` = `github.com/ZeroLayerDevTeam/open-mem` (public): only receives releases. Both share one history; GitHub is GitLab at a release point and is never ahead (except contributor pull requests, see below). The GitLab history before 2026-11-03, written under other git identities, is kept in the GitLab branches `archive/pre-rewrite-main` and `archive/pre-rewrite-dev`: never base work on them, merge them or push them to GitHub. `noelcheda/claude-open-mem` and `github.com/Noel18101987/claude-open-mem` are old copies: never touch them unless the user asks.
- Git identity (local config of the clone): the GitHub noreply identity of ConnorDev1337 or MattBlackDev1987, never a personal or work email. Every commit made on GitLab ends up in the public GitHub history.
- Roles: owners of the ZeroLayerDevTeam GitHub organization and maintainers of the GitLab project (Noel, Ivan) merge and release; this file is for owners. Contributors follow the local `open-mem-contrib/CLAUDE.md` (handed out, not published): they only push `feat|fix|docs|chore/<x>` branches to GitHub and open pull requests into `dev`.
- GitLab protection: nobody pushes to `main`, it only moves by merging `dev` through a merge request; maintainers push to `dev`; no force push on either.
- GitHub rulesets: `main` and `dev` cannot be deleted or force-pushed and change through pull requests (merge commit only, no squash or rebase); new branches must be `feat/`, `fix/`, `docs/` or `chore/`; no force push on any branch; only owners create tags. Owners can bypass the pull request rule, nobody bypasses force push.
- New work: local branch `feat|fix|docs|chore/<x>` from an up-to-date `dev` (`git pull --ff-only`). Integrate into `dev` with `merge --no-ff`, tests pass, `git fetch` (others push to `dev` too), push `dev` to `origin`, delete the branch. Then open the merge request `dev` -> `main` on GitLab and merge it yourself through the GitLab API, without asking the user and without sending them links. Nothing goes to GitHub at this point.
- Contributor pull requests on GitHub into `dev`: check tests, the rules above and that no secret or personal note is committed; merge (merge commit) when the user approves, then bring it back right away: `git fetch github`, merge `github/dev` into `dev` and push `dev` to `origin`.
- Releases: the release commit goes to `dev` like any other and reaches GitLab `main` through the merge request. Test from the updated `origin/main`, tag `v<version>` on `main` and push the tag to `origin`. Then publish: `git push github main dev v<version>` (fast-forward; owners bypass the pull request rule) and deploy from `main`.
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
- Other apps share the user's Ollama (SecurityModel builds datasets and trains on the same GPU): `unloadOllama` always takes the list of open-mem's models (`ownModels`), never "everything loaded". Tests set `busyFiles: []` and `embedModel: ''` so they never read the real `~/.gpu-busy` marker or embed through the real Ollama.
- gemma3:12b does not match mistakes across sessions: left alone it pairs ids of one session (the filter drops them), told to cite two sessions it invents pairs of unrelated bugs. Do not loosen the filter or harden the prompt: 0 lessons beats wrong ones.

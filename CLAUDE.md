# claude-open-mem

Claude Code plugin (id `open-mem`, marketplace `claude-open-mem`): local persistent memory, an open alternative to
claude-mem. Compresses with a local LLM (Ollama) / an OpenAI-compatible endpoint / no LLM — **never** with the
user's Claude subscription (that was claude-mem's limit: it spends the 5-hour quota and pauses at 95 %).

- Stack: Node ≥ 22.13, **zero dependencies** (`node:sqlite` + FTS5). No install step.
- `src/hook.mjs` hooks (enqueue + context/recall) · `src/queue.mjs` background drainer (`drain.lock`), briefs, sync ·
  `src/store.mjs` records, search, recall, session context · `src/items.mjs` notes/tasks + history ·
  `src/views.mjs` web read models · `src/server.mjs` HTTP API + web (`web/`) · `src/auth.mjs` admin token, device keys,
  web sessions · `src/sync.mjs` client push / server ingest · `src/backend.mjs` local vs remote with fallback ·
  `src/mcp-server.mjs` hand-written MCP stdio · `src/claudemem.mjs` import + uninstall · `src/cli.mjs` ·
  `src/semantic.mjs` Ollama embeddings + hybrid search (RRF over FTS and vectors) · `src/export.mjs` Markdown export.
- `local.search` is async (hybrid search): `backend.call` and the server await `local[op]`.
- Upkeep after each drain (`queue.upkeep`): briefs, notes review, embeddings; all stop while a game runs.
- Data: `~/.claude-open-mem/` (`CLAUDE_OPEN_MEM_DATA_DIR` for tests). Schema version in `PRAGMA user_version` (`db.mjs`).
- Test: `node --no-warnings --test "test/*.test.mjs"` · Validate: `claude plugin validate .`
- Personal deployment notes (servers, IPs, keys) live in `DEPLOY.local.md` and `proyecto.md`, both gitignored —
  never commit them.

## Known mistakes — do not repeat

- Plugin names cannot start with `claude-` (reserved by the validator) → id `open-mem`. The repo is `claude-open-mem`.
- `node --test test/` fails on Windows (treated as a module) → use the glob `"test/*.test.mjs"`.
- `node:sqlite` imports in `hook.mjs` are dynamic on purpose, so the old-Node warning still works.
- qwen3:14b does not skip trivial calls; gemma3:12b does and is faster (~4-7 s on an RTX 4060 Ti) → preferred in `auto`.
- Secret redaction (`src/redact.mjs`) on enqueue + insert + prompts + ingest; `cli redact` rescans the DB. The imported
  DB had 75 rows with tokens (GitLab, Context7…) — never store without `redactText`.
- Writing regexes with `\b` through a Python heredoc inserted a backspace (0x08): edit regexes with Edit, not Python.
  Long Python heredocs in Git Bash also hang or break on quotes → use Edit/Write.
- Uninstalling claude-mem never deletes data: `--move-data` only renames.
- No `.mcp.json` at the plugin root: opening Claude Code inside the repo also loads it as a project MCP server without
  `${CLAUDE_PLUGIN_ROOT}` and it fails (`CONNECTION_CLOSED`). The MCP server is declared in `plugin.json` → `mcpServers`.
- `items.kind` (note/task) is not the record `kind` (obs/sum/item): records expose it as `item_kind`.
- MCP tool calls are async: replies can arrive out of order — tests sort by id.
- Never print or paste the admin token / device keys in a transcript: pipe `device add --raw` into `remote connect`,
  and let the user run `token init|reset` themselves.

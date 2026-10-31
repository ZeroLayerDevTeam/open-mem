# Changelog

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

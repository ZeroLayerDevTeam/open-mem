---
name: open-mem
description: Manage claude-open-mem memory - status, web viewer and admin token, shared server and device keys, import from claude-mem, LLM provider settings, project briefs, terminal search, and optional claude-mem uninstall. Use when the user asks about their memory setup, the memory web page, sharing memory between machines, migrating from claude-mem, changing the compression model, or removing claude-mem.
---

# claude-open-mem administration

Inside a session, memory is used through the `open-mem` MCP tools, not this skill:
`search` → `timeline` → `get_observations` to recall; `task_add` / `task_update` / `items_list` for durable to-dos;
`note_add` for decisions and conventions; `project_context` for another project's brief.

This skill covers the CLI. Run it with Bash:

```bash
OM="$(cat ~/.claude-open-mem/plugin-root)/src/cli.mjs"
node --no-warnings "$OM" status
```

(`plugin-root` is written at every session start. If it is missing, the plugin has not run yet: ask the user to restart Claude Code.)

## Commands

| Goal | Command |
|---|---|
| Counts, LLM, mode, claude-mem detection | `node --no-warnings "$OM" status` |
| Import claude-mem history (read-only, incremental) | `node --no-warnings "$OM" import` |
| Process pending queue now | `node --no-warnings "$OM" drain` |
| Hold / release the queue (GPU needed elsewhere) | `node --no-warnings "$OM" pause [--hours N] [reason]` / `resume` |
| Re-queue what an LLM outage lost (count first) | `node --no-warnings "$OM" backfill --from T --to T --dry-run` |
| Rewrite a project brief now | `node --no-warnings "$OM" brief <project>` |
| Show / change settings | `node --no-warnings "$OM" config [set <key> <value>]` |
| Run the web viewer | `node --no-warnings "$OM" serve [--host H] [--port P]` |
| Shared mode: client → server | `node --no-warnings "$OM" remote connect --url URL --name NAME < keyfile` |
| Push unsynced records now | `node --no-warnings "$OM" sync` |
| Server: device keys | `node --no-warnings "$OM" device add|list|remove <name>` |
| Preview / remove claude-mem | `node --no-warnings "$OM" uninstall-claude-mem --dry-run` / `--yes [--move-data]` |

## Secrets: never put them in the conversation

- The web admin token is shown once, to the user, at install. Never ask the user to paste it into chat.
  If it is lost, the user runs `token reset` themselves (suggest `! node "$OM" token reset` so it runs in their terminal);
  the new token is printed once and every browser is logged out.
- Device keys: pipe `device add <name> --raw` straight into `remote connect` (over SSH if needed) so the key never
  appears in the transcript. Never echo it.

## LLM provider (compression)

claude-open-mem never spends the user's Claude plan. `provider`: `auto` (local Ollama if it has a chat model, else
`none`), `ollama`, `openai` (any OpenAI-compatible `baseUrl` + `model` + `apiKey`), or `none` (only edits and shell
commands stored raw; no project briefs).

## Uninstalling claude-mem

Always run `--dry-run` first and show the user the output. Run the real command only after the user confirms in chat.
claude-mem data is never deleted: `--move-data` only renames `~/.claude-mem`. Tell the user to restart Claude Code afterwards.

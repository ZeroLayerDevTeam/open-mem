---
name: open-mem
description: Manage claude-open-mem memory - status, import from claude-mem, LLM provider settings, terminal search, and optional claude-mem uninstall. Use when the user asks about their memory setup, wants to import or migrate from claude-mem, change the compression model, or remove claude-mem.
---

# claude-open-mem administration

Searching memory inside a session uses the `open-mem` MCP tools (`search` → `timeline` → `get_observations`), not this skill.
This skill covers the CLI. Run it with Bash:

```bash
OM="$(cat ~/.claude-open-mem/plugin-root)/src/cli.mjs"
node --no-warnings "$OM" status
```

(`plugin-root` is written at every session start. If it is missing, the plugin has not run yet: ask the user to restart Claude Code.)

## Commands

| Goal | Command |
|---|---|
| Counts, active LLM, claude-mem detection | `node --no-warnings "$OM" status` |
| Import claude-mem history (read-only, incremental, safe to repeat) | `node --no-warnings "$OM" import` |
| Process pending queue now | `node --no-warnings "$OM" drain` |
| Show settings | `node --no-warnings "$OM" config` |
| Change a setting | `node --no-warnings "$OM" config set <key> <value>` |
| Preview claude-mem removal | `node --no-warnings "$OM" uninstall-claude-mem --dry-run` |
| Remove claude-mem plugin | `node --no-warnings "$OM" uninstall-claude-mem --yes [--move-data]` |

## LLM provider (compression)

claude-open-mem never spends the user's Claude plan. Options for `provider`:

- `auto` (default): local Ollama at `http://127.0.0.1:11434` if it has a chat model, else `none`.
- `ollama`: same, with an explicit `model` / `baseUrl`.
- `openai`: any OpenAI-compatible endpoint — set `baseUrl` (e.g. `http://localhost:1234/v1` for LM Studio), `model`, `apiKey`.
- `none`: no LLM; only edits and shell commands are stored, as raw notes.

## Uninstalling claude-mem

Always run `--dry-run` first and show the user the output. Run the real command only after the user confirms in chat.
It does a final import, runs `claude plugin uninstall claude-mem@…`, and stops the claude-mem worker.
claude-mem data is never deleted: `--move-data` only renames `~/.claude-mem` to `~/.claude-mem.removed-<date>`.
Tell the user to restart Claude Code afterwards.

# claude-open-mem

Open, local-first persistent memory for [Claude Code](https://claude.com/claude-code).

claude-open-mem records what happens in your Claude Code sessions, compresses it into searchable observations and
session summaries, and hands the relevant memory back to Claude at the start of each session. It is a drop-in
alternative to [claude-mem](https://cmem.ai/) and imports your claude-mem history automatically.

**It never spends your Claude plan.** Compression runs on a local LLM through [Ollama](https://ollama.com), on any
OpenAI-compatible endpoint you choose, or without any LLM at all.

- Zero dependencies: Node.js ≥ 22.13 built-ins only (`node:sqlite` with FTS5).
- One SQLite file in `~/.claude-open-mem/`. Nothing leaves your machine unless you configure a remote endpoint.
- MCP tools for Claude: `search`, `timeline`, `get_observations`, `save_memory`.
- Automatic, incremental, read-only import from claude-mem; optional claude-mem uninstall.

## Install

Requirements: Claude Code, Node.js ≥ 22.13 on `PATH`. Optional: Ollama with a chat model
(`ollama pull gemma3:12b`, or `gemma3:4b` / `qwen3:8b` on smaller GPUs).

```bash
claude plugin marketplace add <your-github-user>/claude-open-mem
claude plugin install open-mem@claude-open-mem
```

Restart Claude Code. On the first session start claude-open-mem:

1. creates `~/.claude-open-mem/` with `settings.json` and `open-mem.db`;
2. imports your claude-mem database in the background if it finds one (`~/.claude-mem/claude-mem.db`);
3. starts injecting recent memory for the current project.

The plugin id is `open-mem` (Claude Code reserves plugin names that start with `claude-`).

## How it works

| Hook | What it does |
|---|---|
| `SessionStart` | Injects recent summaries and observations for the project (folder name); imports new claude-mem rows. |
| `UserPromptSubmit` | Stores your prompt. |
| `PostToolUse` | Queues the tool call. No network, returns immediately. |
| `Stop` | Queues a summary of the turn. |

A detached background process drains the queue: the LLM decides whether a tool call is worth remembering and writes
a structured observation (title, narrative, facts, concepts, files). At the end of each turn it writes a summary.
If the LLM is unreachable, items wait in the queue until it is back.

## LLM providers

```bash
OM="$(cat ~/.claude-open-mem/plugin-root)/src/cli.mjs"
node "$OM" config set provider auto        # default: local Ollama if it has a chat model, else none
node "$OM" config set model gemma3:12b     # pin a model
node "$OM" config set provider openai      # any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, ...)
node "$OM" config set baseUrl http://localhost:1234/v1
node "$OM" config set provider none        # no LLM: only edits and shell commands, stored raw
```

## CLI

```bash
node "$OM" status                 # counts, active LLM, claude-mem detection
node "$OM" import                 # import new claude-mem rows (safe to repeat)
node "$OM" search nginx certs     # search from the terminal
node "$OM" drain                  # process the queue now
node "$OM" config                 # show settings
```

Inside Claude Code you can also ask Claude to use the `open-mem` skill.

## Migrating from claude-mem

The import is automatic and incremental: while both are installed, every session start copies new claude-mem rows.
The claude-mem database is opened read-only and never modified.

When you are ready to switch:

```bash
node "$OM" uninstall-claude-mem --dry-run         # preview
node "$OM" uninstall-claude-mem --yes             # final import, uninstall plugin, stop its worker
node "$OM" uninstall-claude-mem --yes --move-data # also rename ~/.claude-mem to ~/.claude-mem.removed-<date>
```

claude-open-mem never deletes claude-mem data. If a `claude-mem` launcher stays on `PATH` (installed with npm outside the
plugin), the command tells you where it is.

## Settings (`~/.claude-open-mem/settings.json`)

| Key | Default | Meaning |
|---|---|---|
| `provider` | `auto` | `auto`, `ollama`, `openai`, `none` |
| `model` / `baseUrl` / `apiKey` | empty | Provider details |
| `skipTools` | TodoWrite, AskUserQuestion, … | Tools never recorded |
| `contextObservations` / `contextSummaries` | 30 / 5 | Amount injected at session start |
| `excludedProjects` | `[]` | Folder names never recorded |
| `autoImportClaudeMem` | `true` | Import claude-mem at session start |
| `maxToolChars` | 6000 | Tool output sent to the LLM |

Set `CLAUDE_OPEN_MEM_DATA_DIR` to move the data folder.

## Development

```bash
node --test "test/*.test.mjs"
claude plugin validate .
claude --plugin-dir .   # try the plugin without installing it
```

## License

MIT

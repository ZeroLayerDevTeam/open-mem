# claude-open-mem

Plugin de Claude Code (id `open-mem`, marketplace `claude-open-mem`): memoria persistente local, alternativa
abierta a claude-mem. Comprime con LLM local (Ollama) / endpoint OpenAI-compatible / sin LLM — **nunca** con la
suscripción de Claude (ese era el límite de claude-mem: gasta la cuota de 5 h del plan y se pausa al 95 %).

- Stack: Node ≥ 22.13, **cero dependencias** (`node:sqlite` + FTS5). Nada de pnpm install necesario.
- `src/hook.mjs` hooks (solo encolan) · `src/queue.mjs` drenador en segundo plano (lock `drain.lock`) ·
  `src/store.mjs` lecturas/escrituras + búsqueda · `src/mcp-server.mjs` MCP stdio a mano ·
  `src/claudemem.mjs` importación incremental (solo lectura) + desinstalación · `src/cli.mjs`.
- Datos: `~/.claude-open-mem/` (`CLAUDE_OPEN_MEM_DATA_DIR` para tests).
- Test: `node --no-warnings --test "test/*.test.mjs"` · Validar: `claude plugin validate .`

## Errores conocidos — no repetir

- El nombre de plugin no puede empezar por `claude-` (reservado por el validador) → id `open-mem`.
  El repo/proyecto sí se llama `claude-open-mem`.
- `node --test test/` falla en Windows (lo trata como módulo) → usar el glob `"test/*.test.mjs"`.
- Los imports de `node:sqlite` en `hook.mjs` son dinámicos a propósito: así el aviso de Node antiguo funciona.
- qwen3:14b no descarta llamadas triviales; gemma3:12b sí y es más rápido (~4-7 s en RTX 4060 Ti) → preferido en `auto`.
- Redacción de secretos (`src/redact.mjs`) en enqueue + insert + prompts; `cli redact` re-escanea la BD. La
  BD importada traía 75 filas con tokens (GitLab, Context7…) — nunca guardar sin pasar por `redactText`.
- Al escribir regex con `\b` desde Python heredoc se coló un `` (backspace): editar regex con Edit, no con Python.
- Desinstalar claude-mem nunca borra datos: `--move-data` solo renombra.
- No usar `.mcp.json` en la raíz del plugin: al abrir Claude Code dentro del repo se carga también como MCP de
  proyecto, sin `${CLAUDE_PLUGIN_ROOT}`, y falla (`CONNECTION_CLOSED`). El MCP se declara en `plugin.json` → `mcpServers`.

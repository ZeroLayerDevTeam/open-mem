# Bitácora — claude-open-mem

## 2026-10-31 — v0.1.0
- Diagnóstico: el "límite" de claude-mem es que resume cada tool call con Claude vía la suscripción
  (`CLAUDE_MEM_CLAUDE_AUTH_METHOD=subscription`); al 95 % de la ventana de 5 h pausa la captura
  (27 oct: `quota:five_hour`, 424 pendientes). Pro = sacar eso del plan.
- Construido plugin completo: hooks, cola + drenador, MCP (search/timeline/get_observations/save_memory),
  importador incremental, desinstalación opcional, skill `open-mem`, CLI, README, tests (6/6 OK).
- Importación real: 16.724 observaciones, 2.819 resúmenes, 3.797 prompts en 2,4 s → `~/.claude-open-mem/open-mem.db`.
- Ollama local (gemma3:12b / qwen3:14b) probado: JSON correcto, en español tras ajustar prompt.
- Pendiente: publicar en GitHub (repo público), icono 512 px, instalar el plugin aquí y retirar claude-mem.

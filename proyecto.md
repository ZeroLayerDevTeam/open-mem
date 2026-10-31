# Bitácora — claude-open-mem

## 2026-10-31 — v0.1.0
- Diagnóstico: el "límite" de claude-mem es que resume cada tool call con Claude vía la suscripción
  (`CLAUDE_MEM_CLAUDE_AUTH_METHOD=subscription`); al 95 % de la ventana de 5 h pausa la captura
  (27 oct: `quota:five_hour`, 424 pendientes). Pro = sacar eso del plan.
- Construido plugin completo: hooks, cola + drenador, MCP (search/timeline/get_observations/save_memory),
  importador incremental, desinstalación opcional, skill `open-mem`, CLI, README, tests (6/6 OK).
- Importación real: 16.724 observaciones, 2.819 resúmenes, 3.797 prompts en 2,4 s → `~/.claude-open-mem/open-mem.db`.
- Ollama local (gemma3:12b / qwen3:14b) probado: JSON correcto, en español tras ajustar prompt.
- Seguridad: redacción de secretos añadida (7/7 tests); aplicada a la BD real → 75 filas limpiadas, 0 tokens
  restantes (verificado por regex en filas y en el fichero). La base de claude-mem original sigue teniendo los tokens.
- Repo interno GitLab privado `noelcheda/claude-open-mem`; GitHub público cuando esté probado al 100 %.
- v0.1.1: desinstalador cubre todos los scopes (`claude plugin list --json`) y usa `--keep-data`.
- Instalado en la torre desde GitLab (`claude plugin marketplace add https://gitlab.com/noelcheda/claude-open-mem.git`,
  `open-mem@claude-open-mem`). Las 4 cuentas de `~/.ccm/accounts/*` comparten `~/.claude/plugins` (symlink).
- claude-mem desinstalado (scope user + project en `C:\Users\Personal`), worker parado, datos intactos en
  `~/.claude-mem/`. Copia extra: `~/.claude-mem-backup-2026-10-31/` (BD con VACUUM INTO, integrity ok, settings,
  installed_plugins, known_marketplaces). Marketplace `thedotmack` se conserva. Launchers npm/LocalAppData se dejan.
  **Revertir**: `claude plugin install claude-mem@thedotmack` (+ `--scope project` desde `C:\Users\Personal`).
- Pendiente: publicar en GitHub (repo público), icono 512 px, instalar el plugin aquí y retirar claude-mem.
- v0.1.2: comprobado en sesión real tras reinicio — hooks inyectan contexto, prompt y observaciones capturados,
  MCP `plugin:open-mem` responde. Fallaba un 2.º servidor `open-mem` (el `.mcp.json` del repo cargado como MCP de
  proyecto) → MCP movido a `plugin.json`.

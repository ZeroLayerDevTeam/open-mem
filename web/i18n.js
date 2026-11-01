// Language (English / Spanish) and theme (auto / light / dark) of the web viewer. Both are per browser (localStorage).
// Strings are written in English in the code and looked up here; {name} placeholders are filled from `vars`.
// Dates, numbers and relative times come from Intl in the chosen locale.
const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode: not remembered */ } };

export const LANGS = [['en', 'English'], ['es', 'Español']];
export let lang = read('om-lang') || ((navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en');
if (!LANGS.some(([l]) => l === lang)) lang = 'en';
export const locale = () => (lang === 'es' ? 'es-ES' : 'en-GB');

export function t(text, vars) {
  const s = (lang === 'es' && ES[text]) || text;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

export function setLang(next) {
  write('om-lang', next);
  lang = next;
  document.documentElement.lang = locale();
  translateStatic();
}

// Static markup in index.html: data-i18n (text), data-i18n-placeholder, data-i18n-aria (aria-label), data-i18n-html.
export function translateStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}

export const THEMES = [['auto', 'Auto (system)'], ['light', 'Light'], ['dark', 'Dark']];
export let theme = read('om-theme') || 'auto';
export function setTheme(next) {
  theme = THEMES.some(([v]) => v === next) ? next : 'auto';
  write('om-theme', theme);
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
setTheme(theme);
document.documentElement.lang = locale();

const ES = {
  // shell, login
  'Sign in to open-mem': 'Entrar en open-mem',
  'Paste the admin token printed when the plugin was installed.': 'Pega el token de administrador que se mostró al instalar el plugin.',
  'Admin token': 'Token de administrador',
  'Log in': 'Entrar',
  'Lost it? Run <code>token reset</code> with the open-mem CLI on the machine that holds the database.':
    '¿Lo perdiste? Ejecuta <code>token reset</code> con la CLI de open-mem en la máquina que guarda la base de datos.',
  'wrong token': 'token incorrecto',
  'too many attempts, wait 15 minutes': 'demasiados intentos, espera 15 minutos',
  'login required': 'hay que iniciar sesión',
  Sections: 'Secciones',
  Menu: 'Menú',
  Progress: 'Progreso',
  Projects: 'Proyectos',
  Timeline: 'Cronología',
  Tasks: 'Tareas',
  Notes: 'Notas',
  Search: 'Buscar',
  Sessions: 'Sesiones',
  'Search memory': 'Buscar en la memoria',
  'Log out': 'Cerrar sesión',
  'Record detail': 'Detalle del registro',
  Close: 'Cerrar',
  'Copy reference': 'Copiar referencia',
  'Copied {ref}': '{ref} copiado',
  Language: 'Idioma',
  Theme: 'Tema',
  'Auto (system)': 'Automático (sistema)',
  Light: 'Claro',
  Dark: 'Oscuro',
  'Could not load this page: {error}': 'No se pudo cargar esta página: {error}',
  // time, numbers, paging
  never: 'nunca',
  'just now': 'ahora mismo',
  'under a minute': 'menos de un minuto',
  '{n} min': '{n} min',
  '{h} h {m} min': '{h} h {m} min',
  duration: 'duración',
  Pages: 'Páginas',
  'Page {n}': 'Página {n}',
  'Page {n} of {pages}': 'Página {n} de {pages}',
  'Previous page': 'Página anterior',
  'Next page': 'Página siguiente',
  '{from}-{to} of {total}': '{from}-{to} de {total}',
  '{n} results': '{n} resultados',
  '{n} records': '{n} registros',
  '{n} more': '{n} más',
  // record drawer
  'Open record {ref}': 'Abrir el registro {ref}',
  Project: 'Proyecto',
  Directory: 'Directorio',
  Device: 'Máquina',
  Branch: 'Rama',
  Commit: 'Commit',
  Tool: 'Herramienta',
  Model: 'Modelo',
  Session: 'Sesión',
  Prompt: 'Prompt',
  Created: 'Creado',
  Updated: 'Actualizado',
  Source: 'Origen',
  'session summary': 'resumen de sesión',
  'Session summary': 'Resumen de sesión',
  Investigated: 'Investigado',
  Learned: 'Aprendido',
  Completed: 'Completado',
  'Next steps': 'Siguientes pasos',
  'Files modified': 'Archivos modificados',
  'Files read': 'Archivos leídos',
  History: 'Historial',
  observation: 'observación',
  '(untitled)': '(sin título)',
  Facts: 'Hechos',
  Concepts: 'Conceptos',
  'What happened around this': 'Qué pasó alrededor',
  'Around this record': 'Alrededor de este registro',
  'Open session': 'Abrir la sesión',
  Title: 'Título',
  Details: 'Detalles',
  Status: 'Estado',
  Priority: 'Prioridad',
  High: 'Alta',
  Normal: 'Normal',
  Low: 'Baja',
  'Due date': 'Fecha límite',
  'Progress comment (optional)': 'Comentario de progreso (opcional)',
  Comment: 'Comentario',
  'Save changes': 'Guardar cambios',
  Saved: 'Guardado',
  Delete: 'Borrar',
  Deleted: 'Borrado',
  'Click again to delete for good': 'Pulsa otra vez para borrarlo definitivamente',
  // statuses, kinds, events
  todo: 'por hacer',
  doing: 'en curso',
  blocked: 'bloqueada',
  done: 'hecha',
  cancelled: 'cancelada',
  active: 'activa',
  archived: 'archivada',
  note: 'nota',
  task: 'tarea',
  created: 'creada',
  status: 'estado',
  updated: 'actualizada',
  comment: 'comentario',
  deleted: 'borrada',
  edited: 'editada',
  discovery: 'descubrimiento',
  decision: 'decisión',
  bugfix: 'corrección',
  feature: 'función',
  refactor: 'refactor',
  change: 'cambio',
  other: 'otro',
  contradiction: 'contradicción',
  outdated: 'obsoleta',
  duplicate: 'duplicada',
  // progress
  'Everything Claude has remembered across your machines, and the work still open.':
    'Todo lo que Claude ha recordado en tus máquinas y el trabajo que sigue abierto.',
  Summary: 'Resumen',
  'tasks in progress': 'tareas en curso',
  'tasks waiting': 'tareas pendientes',
  'tasks done this week': 'tareas hechas esta semana',
  observations: 'observaciones',
  sessions: 'sesiones',
  projects: 'proyectos',
  prompts: 'prompts',
  'session summaries': 'resúmenes de sesión',
  notes: 'notas',
  'open tasks': 'tareas abiertas',
  Activity: 'Actividad',
  'Records per day, last {n} weeks': 'Registros por día, últimas {n} semanas',
  '{day}: {n} records': '{day}: {n} registros',
  Less: 'Menos',
  More: 'Más',
  'Open tasks': 'Tareas abiertas',
  'All tasks': 'Todas las tareas',
  'No open tasks. Ask Claude to track work with <code>task_add</code>, or add one under Tasks.':
    'No hay tareas abiertas. Pide a Claude que siga el trabajo con <code>task_add</code>, o añade una en Tareas.',
  'Latest sessions': 'Últimas sesiones',
  'All sessions': 'Todas las sesiones',
  'No sessions yet.': 'Aún no hay sesiones.',
  '(no prompt)': '(sin prompt)',
  '{n} prompts': '{n} prompts',
  '{n} observations': '{n} observaciones',
  'due {day}': 'vence {day}',
  'Active projects': 'Proyectos activos',
  'All projects': 'Todos los proyectos',
  Machines: 'Máquinas',
  'Records captured from now on carry the machine they came from.': 'Los registros que se capturen a partir de ahora llevan la máquina de la que vienen.',
  '{n} records not yet pushed to the shared server.': '{n} registros aún sin enviar al servidor compartido.',
  // projects
  'One row per working folder. Open one for its brief, tasks, notes and history.':
    'Una fila por carpeta de trabajo. Ábrela para ver su resumen, tareas, notas e historial.',
  'Filter projects': 'Filtrar proyectos',
  'Last activity': 'Última actividad',
  Observations: 'Observaciones',
  'since {day}': 'desde {day}',
  '{done} of {total} tasks done': '{done} de {total} tareas hechas',
  'No project matches “{query}”.': 'Ningún proyecto coincide con «{query}».',
  'First record {first}, last activity {last}': 'Primer registro {first}, última actividad {last}',
  Export: 'Exportar',
  Brief: 'Resumen del proyecto',
  'Claude reads this at the start of every session.': 'Claude lo lee al empezar cada sesión.',
  'Written by {model}.': 'Escrito por {model}.',
  'No brief yet. It is written by the local LLM after enough sessions.': 'Aún no hay resumen. Lo escribe el LLM local tras suficientes sesiones.',
  'Task board': 'Tablero de tareas',
  'No open tasks.': 'No hay tareas abiertas.',
  'Recent session summaries': 'Resúmenes de sesión recientes',
  'No session summaries yet.': 'Aún no hay resúmenes de sesión.',
  'Notes to check': 'Notas a revisar',
  'Local LLM review of {day}.': 'Revisión del LLM local del {day}.',
  'All notes': 'Todas las notas',
  'Most-edited files': 'Archivos más editados',
  Branches: 'Ramas',
  'Kinds of observation': 'Tipos de observación',
  // timeline
  'Everything recorded, newest first. Filled dots are session summaries, red squares are note and task changes.':
    'Todo lo registrado, lo más reciente primero. Los puntos rellenos son resúmenes de sesión; los cuadrados rojos, cambios en notas y tareas.',
  'All machines': 'Todas las máquinas',
  Show: 'Mostrar',
  Summaries: 'Resúmenes',
  'Notes & tasks': 'Notas y tareas',
  'Up to': 'Hasta',
  'Nothing recorded for this filter.': 'No hay nada registrado con este filtro.',
  'Try another project, machine or date.': 'Prueba con otro proyecto, máquina o fecha.',
  // sessions
  'Every Claude Code conversation, with the machine and branch it ran on.': 'Cada conversación de Claude Code, con la máquina y la rama donde se ejecutó.',
  'Search prompts': 'Buscar en los prompts',
  'No sessions match.': 'Ninguna sesión coincide.',
  'Sessions appear here as soon as Claude Code runs with the plugin.': 'Las sesiones aparecen aquí en cuanto Claude Code se ejecuta con el plugin.',
  'Show the full prompt': 'Ver el prompt completo',
  'Other records': 'Otros registros',
  // tasks
  'To do': 'Por hacer',
  Doing: 'En curso',
  Blocked: 'Bloqueadas',
  Done: 'Hechas',
  'Done (7 days)': 'Hechas (7 días)',
  'No project': 'Sin proyecto',
  '{n} open': 'abiertas: {n}',
  'Ask Claude to track work with <code>task_add</code>, or add one above.': 'Pide a Claude que siga el trabajo con <code>task_add</code>, o añade una arriba.',
  'Durable to-dos Claude and you share across sessions and machines. Drag a card to another column to change its status; Claude moves them with <code>task_update</code>.':
    'Pendientes duraderos que compartís Claude y tú entre sesiones y máquinas. Arrastra una tarjeta a otra columna para cambiar su estado (en el móvil, mantenla pulsada y arrastra); Claude las mueve con <code>task_update</code>.',
  'New task, as an action': 'Nueva tarea, como una acción',
  'New task': 'Nueva tarea',
  'Add task': 'Añadir tarea',
  'Task added': 'Tarea añadida',
  'Moved to {status}': 'Movida a {status}',
  'Show project': 'Mostrar proyecto',
  'All projects, by project': 'Todos los proyectos, por proyecto',
  // notes
  'Decisions, conventions and gotchas worth keeping. Claude writes them with <code>note_add</code> and reads them at session start.':
    'Decisiones, convenciones y trampas que vale la pena guardar. Claude las escribe con <code>note_add</code> y las lee al empezar cada sesión.',
  'New note': 'Nueva nota',
  'Note title': 'Título de la nota',
  'Save note': 'Guardar nota',
  'Note saved': 'Nota guardada',
  'Search notes': 'Buscar en las notas',
  Active: 'Activas',
  Archived: 'Archivadas',
  All: 'Todas',
  'No notes yet.': 'Aún no hay notas.',
  'No notes match “{query}”.': 'Ninguna nota coincide con «{query}».',
  'Write the first one with New note, or ask Claude to save a decision.': 'Escribe la primera con Nueva nota, o pide a Claude que guarde una decisión.',
  // search
  'The same search Claude uses: full-text, plus meaning when the embedding model is available. Words match by prefix.':
    'La misma búsqueda que usa Claude: texto completo y, si el modelo de embeddings está disponible, también por significado. Las palabras coinciden por prefijo.',
  'What are you looking for?': '¿Qué buscas?',
  Kind: 'Tipo',
  Type: 'Clase',
  'Any type': 'Cualquier clase',
  From: 'Desde',
  To: 'Hasta',
  Everything: 'Todo',
  'Recent searches': 'Búsquedas recientes',
  'Search a file name, an error message, a decision or a command. Filters on their own list the latest matching records.':
    'Busca un nombre de archivo, un mensaje de error, una decisión o un comando. Los filtros por sí solos listan los últimos registros que coinciden.',
  '{n} results for “{query}”': '{n} resultados para «{query}»',
  '1 result for “{query}”': '1 resultado para «{query}»',
  'No matches for “{query}”.': 'Sin resultados para «{query}».',
  'Nothing matches these filters.': 'Nada coincide con estos filtros.',
  'Try fewer words, another kind or a wider date range.': 'Prueba con menos palabras, otro tipo o un rango de fechas más amplio.',
};

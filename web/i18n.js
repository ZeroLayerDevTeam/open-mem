// Language (English / Spanish) and theme (auto / light / dark) of the web viewer. Both are per browser (localStorage).
// Strings are written in English in the code and looked up here; {name} placeholders are filled from `vars`.
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
  document.documentElement.lang = next;
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
document.documentElement.lang = lang;

const ES = {
  // shell, login
  'Paste the admin token printed when the plugin was installed.': 'Pega el token de administrador que se mostró al instalar el plugin.',
  'Admin token': 'Token de administrador',
  'Log in': 'Entrar',
  'Lost it? Run <code>token reset</code> with the open-mem CLI on the machine that holds the database.':
    '¿Lo perdiste? Ejecuta <code>token reset</code> con la CLI de open-mem en la máquina que guarda la base de datos.',
  Sections: 'Secciones',
  Progress: 'Progreso',
  Projects: 'Proyectos',
  Timeline: 'Cronología',
  Tasks: 'Tareas',
  Notes: 'Notas',
  Search: 'Buscar',
  Sessions: 'Sesiones',
  'Log out': 'Cerrar sesión',
  'Record detail': 'Detalle del registro',
  Close: 'Cerrar',
  Language: 'Idioma',
  Theme: 'Tema',
  'Auto (system)': 'Automático (sistema)',
  Light: 'Claro',
  Dark: 'Oscuro',
  'login required': 'hay que iniciar sesión',
  'Could not load this page: {error}': 'No se pudo cargar esta página: {error}',
  // time
  never: 'nunca',
  'just now': 'ahora mismo',
  '{n} min ago': 'hace {n} min',
  '{n} h ago': 'hace {n} h',
  '{n} d ago': 'hace {n} d',
  // drawer
  'Loading…': 'Cargando…',
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
  Delete: 'Borrar',
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
  // overview
  '{day}: {n} records': '{day}: {n} registros',
  'Records per day, last {n} days': 'Registros por día, últimos {n} días',
  'due {day}': 'vence {day}',
  'no project': 'sin proyecto',
  'Everything Claude has remembered across your machines, and the work still open.':
    'Todo lo que Claude ha recordado en tus máquinas y el trabajo que sigue abierto.',
  'tasks in progress': 'tareas en curso',
  'tasks waiting': 'tareas pendientes',
  'tasks done this week': 'tareas hechas esta semana',
  observations: 'observaciones',
  'session summaries': 'resúmenes de sesión',
  notes: 'notas',
  Activity: 'Actividad',
  'Open tasks': 'Tareas abiertas',
  'No open tasks. Ask Claude to track work with <code>task_add</code>, or add one under Tasks.':
    'No hay tareas abiertas. Pide a Claude que siga el trabajo con <code>task_add</code>, o añade una en Tareas.',
  'Latest sessions': 'Últimas sesiones',
  '(no prompt)': '(sin prompt)',
  '{n} prompts': '{n} prompts',
  '{n} observations': '{n} observaciones',
  'Active projects': 'Proyectos activos',
  Machines: 'Máquinas',
  '{n} records not yet pushed to the shared server.': '{n} registros aún sin enviar al servidor compartido.',
  // projects
  'One card per working folder. Open one for its brief, tasks, notes and history.':
    'Una ficha por carpeta de trabajo. Ábrela para ver su resumen, tareas, notas e historial.',
  'Filter projects': 'Filtrar proyectos',
  '{n} sessions': '{n} sesiones',
  'last {when}': 'último {when}',
  '{open} open · {done} done': '{open} abiertas · {done} hechas',
  '{n} notes': '{n} notas',
  '{done} of {total} tasks done': '{done} de {total} tareas hechas',
  '{obs} observations · {sums} sessions · since {first} · last {last}': '{obs} observaciones · {sums} sesiones · desde {first} · último {last}',
  Brief: 'Resumen',
  'Generated {when}': 'Generado {when}',
  ' by {model}': ' por {model}',
  '. Claude reads this at the start of every session.': '. Claude lo lee al empezar cada sesión.',
  'No brief yet. It is written by the local LLM after enough sessions.': 'Aún no hay resumen. Lo escribe el LLM local tras suficientes sesiones.',
  'None.': 'Ninguna.',
  'Recent sessions': 'Sesiones recientes',
  'Full timeline for {project}': 'Cronología completa de {project}',
  'Export notes and tasks (Markdown)': 'Exportar notas y tareas (Markdown)',
  'Notes to check': 'Notas a revisar',
  'Local LLM review of {day}.': 'Revisión del LLM local del {day}.',
  'Most-edited files': 'Archivos más editados',
  Branches: 'Ramas',
  'Kinds of observation': 'Tipos de observación',
  // timeline
  'What happened, newest first. Filled dots are session summaries, red squares are note and task changes.':
    'Lo que pasó, lo más reciente primero. Los puntos rellenos son resúmenes de sesión; los cuadrados rojos, cambios en notas y tareas.',
  'All projects': 'Todos los proyectos',
  Observations: 'Observaciones',
  Summaries: 'Resúmenes',
  'Notes & tasks': 'Notas y tareas',
  'Show older': 'Ver anteriores',
  'Nothing recorded yet for this filter.': 'Aún no hay nada registrado con este filtro.',
  // tasks
  'To do': 'Por hacer',
  Doing: 'En curso',
  Blocked: 'Bloqueadas',
  Done: 'Hechas',
  'Done (7 days)': 'Hechas (7 días)',
  'No project': 'Sin proyecto',
  '{n} open': '{n} abiertas',
  'No open tasks.': 'No hay tareas abiertas.',
  'Durable to-dos Claude and you share across sessions and machines. Drag a card to another column to change its status; Claude moves them with <code>task_update</code>.':
    'Pendientes duraderos que compartís Claude y tú entre sesiones y máquinas. Arrastra una tarjeta a otra columna para cambiar su estado (en el móvil, mantenla pulsada y arrastra); Claude las mueve con <code>task_update</code>.',
  'New task, as an action': 'Nueva tarea, como una acción',
  'New task': 'Nueva tarea',
  'Add task': 'Añadir tarea',
  'Show project': 'Mostrar proyecto',
  'All projects, by project': 'Todos los proyectos, por proyecto',
  // notes
  'Decisions, conventions and gotchas worth keeping. Claude writes them with <code>note_add</code> and reads them at session start.':
    'Decisiones, convenciones y trampas que vale la pena guardar. Claude las escribe con <code>note_add</code> y las lee al empezar cada sesión.',
  'Note title': 'Título de la nota',
  'Save note': 'Guardar nota',
  'No notes yet.': 'Aún no hay notas.',
  // search
  'The same search Claude uses: full-text, plus meaning when the embedding model is available. Words match by prefix.':
    'La misma búsqueda que usa Claude: texto completo y, si el modelo de embeddings está disponible, también por significado. Las palabras coinciden por prefijo.',
  'What are you looking for?': '¿Qué buscas?',
  Kind: 'Tipo',
  Everything: 'Todo',
  'No matches for “{query}”.': 'Sin resultados para «{query}».',
  // sessions
  'Every Claude Code conversation, with the machine and branch it ran on.': 'Cada conversación de Claude Code, con la máquina y la rama donde se ejecutó.',
  Summary: 'Resumen',
};

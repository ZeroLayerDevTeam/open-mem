// open-mem web viewer. No framework: hash routes, one fetch helper, escaped templates.
import { LANGS, THEMES, lang, locale, setLang, setTheme, t, theme, translateStatic } from './i18n.js';

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');

// --- escaped templates ----------------------------------------------------------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(String(s));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flat = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(flat).join('') : v === false || v == null ? '' : esc(v));
const html = (strings, ...vals) => raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? flat(vals[i]) : ''), ''));
// Translated text that contains markup (<code>) of our own dictionary, never user data.
const tr = (text, vars) => raw(t(text, vars));

// --- api -------------------------------------------------------------------------------
const LOGIN_REQUIRED = 'login required';
async function api(path, body) {
  const res = await fetch(path, body === undefined ? { credentials: 'same-origin' } : {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error(LOGIN_REQUIRED); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const q = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();

// --- formatting -----------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => { const d = new Date(Number(ms)); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const timeOf = (ms) => { const d = new Date(Number(ms)); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const weekday = (ms) => new Date(Number(ms)).toLocaleDateString(locale(), { weekday: 'short', month: 'short', day: 'numeric' });
function ago(ms) {
  if (!ms) return t('never');
  const s = (Date.now() - Number(ms)) / 1000;
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n} min ago', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n} h ago', { n: Math.round(s / 3600) });
  if (s < 86400 * 30) return t('{n} d ago', { n: Math.round(s / 86400) });
  return dayOf(ms);
}
const clip = (s, n) => { const v = String(s ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };
const list = (v) => { if (!v) return []; try { const a = JSON.parse(v); return Array.isArray(a) ? a : [String(v)]; } catch { return [String(v)]; } };
const refOf = (r) => (r.kind === 'sum' ? `S${r.id}` : r.kind === 'item' || r.kind === 'event' ? `I${r.id}` : `${r.id}`);
const refLink = (ref) => html`<a class="ref" href="#" data-ref="${ref}">${ref}</a>`;
const typeTag = (type) => (type ? html`<span class="tag type-${type}">${t(type)}</span>` : '');
const fmt = (n) => Number(n || 0).toLocaleString(locale());

// --- language and theme ----------------------------------------------------------------
function fillPrefs() {
  for (const sel of document.querySelectorAll('select[data-pref]')) {
    const isLang = sel.dataset.pref === 'lang';
    sel.innerHTML = (isLang ? LANGS : THEMES).map(([v, l]) => html`<option value="${v}">${isLang ? l : t(l)}</option>`).join('');
    sel.value = isLang ? lang : theme;
  }
}
document.addEventListener('change', (e) => {
  const pref = e.target.dataset?.pref;
  if (pref === 'theme') { setTheme(e.target.value); fillPrefs(); }
  if (pref === 'lang') {
    setLang(e.target.value);
    fillPrefs();
    closeDrawer();
    if (!$('#app').hidden) route();
  }
});
translateStatic();
fillPrefs();

// --- login --------------------------------------------------------------------------------
function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#token').focus();
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { token: $('#token').value.trim() });
    $('#token').value = '';
    start();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', {}).catch(() => {}); showLogin(); });

// --- drawer ------------------------------------------------------------------------------------
const drawer = $('#drawer');
function closeDrawer() { drawer.hidden = true; }
$('#drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-ref]');
  if (!a) return;
  e.preventDefault();
  openRecord(a.dataset.ref);
});

function metaList(r) {
  const rows = [
    ['Project', r.project], ['Directory', r.directory || r.cwd], ['Device', r.device], ['Branch', r.git_branch],
    ['Commit', r.git_commit], ['Tool', r.tool], ['Model', r.model], ['Session', r.session_id && html`<a href="#/session/${encodeURIComponent(r.session_id)}">${clip(r.session_id, 18)}</a>`],
    ['Prompt', r.prompt_number && `#${r.prompt_number}`], ['Created', r.created_at && `${dayOf(r.created_at)} ${timeOf(r.created_at)}`],
    ['Updated', r.updated_at && `${dayOf(r.updated_at)} ${timeOf(r.updated_at)}`], ['Source', r.source],
  ].filter(([, v]) => v);
  return html`<dl>${rows.map(([k, v]) => html`<dt>${t(k)}</dt><dd>${v}</dd>`)}</dl>`;
}
const section = (label, body) => (body ? html`<h3>${t(label)}</h3>${body}` : '');
const bullets = (v) => { const a = list(v); return a.length ? html`<ul>${a.map((x) => html`<li>${x}</li>`)}</ul>` : ''; };

async function openRecord(ref) {
  drawer.hidden = false;
  $('#drawer-body').innerHTML = html`<p class="muted">${t('Loading…')}</p>`.s;
  let r;
  try { r = await api(`/api/record?${q({ ref })}`); } catch (err) { $('#drawer-body').textContent = err.message; return; }
  let body;
  if (r.kind === 'sum') {
    body = html`<p class="ref">S${r.id} · ${t('session summary')}</p><h2>${r.request || t('Session summary')}</h2>
      ${[['Investigated', r.investigated], ['Learned', r.learned], ['Completed', r.completed], ['Next steps', r.next_steps], ['Notes', r.notes]]
        .map(([k, v]) => section(k, v && html`<div class="prose">${v}</div>`))}
      ${section('Files modified', bullets(r.files_modified))}${metaList(r)}`;
  } else if (r.kind === 'item') {
    body = html`<p class="ref">I${r.id} · ${t(r.item_kind)} · ${t(r.status)}</p>${itemEditor(r)}${metaList(r)}
      ${section('History', html`<ul>${(r.events || []).map((e) => html`<li><span class="num">${dayOf(e.at)} ${timeOf(e.at)}</span> · ${t(e.event)}${e.to_status ? ` → ${t(e.to_status)}` : ''}${e.detail ? `: ${e.detail}` : ''}${e.device ? html` <span class="muted">(${e.device})</span>` : ''}</li>`)}</ul>`)}`;
  } else {
    body = html`<p class="ref">${r.id} · ${t('observation')} ${typeTag(r.type)}</p><h2>${r.title || t('(untitled)')}</h2>
      ${r.subtitle ? html`<p class="muted">${r.subtitle}</p>` : ''}${r.narrative ? html`<div class="prose">${r.narrative}</div>` : ''}
      ${section('Facts', bullets(r.facts))}${section('Concepts', list(r.concepts).length ? html`<p>${list(r.concepts).map((c) => html`<span class="tag">${c}</span> `)}</p>` : '')}
      ${section('Files modified', bullets(r.files_modified))}${section('Files read', bullets(r.files_read))}${metaList(r)}
      <p><button class="secondary" data-around="${r.id}">${t('What happened around this')}</button></p>`;
  }
  $('#drawer-body').innerHTML = body;
  wireItemEditor(r);
  $('[data-around]', drawer)?.addEventListener('click', async (e) => {
    const res = await api('/api/timeline', { anchor: e.target.dataset.around, before: 6, after: 6 });
    e.target.replaceWith(Object.assign(document.createElement('div'), {
      innerHTML: html`<ul class="rows">${(res.result || []).map((x) => html`<li><span>${refLink(refOf(x))}</span><span class="title" data-ref="${refOf(x)}">${x.anchor ? '▸ ' : ''}${clip(x.title, 100)}</span><span class="side">${dayOf(x.created_at)}</span></li>`)}</ul>`.s,
    }));
  });
}
function itemEditor(r) {
  const isTask = r.item_kind === 'task';
  const statuses = isTask ? ['todo', 'doing', 'blocked', 'done', 'cancelled'] : ['active', 'archived'];
  return html`<form class="composer" id="item-form">
    <input type="text" name="title" value="${r.title}" aria-label="${t('Title')}" required>
    <textarea name="body" aria-label="${t('Details')}">${r.body || ''}</textarea>
    <div class="line">
      <select name="status" aria-label="${t('Status')}">${statuses.map((s) => html`<option value="${s}" ${s === r.status ? raw('selected') : ''}>${t(s)}</option>`)}</select>
      ${isTask ? html`<select name="priority" aria-label="${t('Priority')}">${[[1, 'High'], [2, 'Normal'], [3, 'Low']].map(([v, l]) => html`<option value="${v}" ${v === r.priority ? raw('selected') : ''}>${t(l)}</option>`)}</select>
        <input type="date" name="due" aria-label="${t('Due date')}" value="${r.due_at ? dayOf(r.due_at) : ''}">` : ''}
    </div>
    <input type="text" name="comment" placeholder="${t('Progress comment (optional)')}" aria-label="${t('Comment')}">
    <div class="line"><button type="submit">${t('Save changes')}</button><button type="button" class="secondary" id="item-delete">${t('Delete')}</button></div>
    <p class="error" id="item-error"></p>
  </form>`;
}
function wireItemEditor(r) {
  const form = $('#item-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const patch = { title: f.get('title'), body: f.get('body'), status: f.get('status'), comment: f.get('comment') || undefined };
    if (f.has('priority')) patch.priority = Number(f.get('priority'));
    if (f.has('due')) patch.due = f.get('due') || null;
    try { await api('/api/items/update', { id: r.id, patch }); openRecord(`I${r.id}`); route(); } catch (err) { $('#item-error').textContent = err.message; }
  });
  $('#item-delete').addEventListener('click', async (e) => {
    if (e.target.dataset.confirm !== '1') { e.target.dataset.confirm = '1'; e.target.textContent = t('Click again to delete for good'); return; }
    await api('/api/items/delete', { id: r.id });
    closeDrawer();
    route();
  });
}

// --- views ---------------------------------------------------------------------------------------
function activityStrip(rows, days = 119) {
  const map = new Map(rows.map((r) => [r.day, r.n]));
  const max = Math.max(1, ...rows.map((r) => r.n));
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const startDay = new Date(end); startDay.setDate(end.getDate() - days - end.getDay());
  const cells = [];
  for (let d = new Date(startDay); d <= end; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const n = map.get(key) || 0;
    const l = n ? Math.min(4, Math.ceil((n / max) * 4)) : 0;
    cells.push(html`<i data-l="${l}" title="${t('{day}: {n} records', { day: key, n })}"></i>`);
  }
  return html`<div class="strip" role="img" aria-label="${t('Records per day, last {n} days', { n: days })}">${cells}</div>`;
}

function taskRow(task) {
  return html`<li><span>${refLink(`I${task.id}`)}</span><span class="title" data-ref="I${task.id}">${task.title}</span>
    <span class="side"><span class="status ${task.status}">${t(task.status)}</span>${task.due_at ? ` · ${t('due {day}', { day: dayOf(task.due_at) })}` : ''}</span>
    <span class="sub">${task.project || t('no project')}${task.directory ? ` · ${task.directory}` : ''}</span></li>`;
}

async function overviewView() {
  const o = await api('/api/overview');
  const s = o.stats;
  const tasksBy = Object.fromEntries(o.tasks.map((x) => [x.status, x.n]));
  view.innerHTML = html`<h1 class="page">${t('Progress')}</h1>
    <p class="lede">${t('Everything Claude has remembered across your machines, and the work still open.')}</p>
    <div class="figures">
      <div class="figure"><b>${fmt(tasksBy.doing)}</b><span>${t('tasks in progress')}</span></div>
      <div class="figure"><b>${fmt((tasksBy.todo || 0) + (tasksBy.blocked || 0))}</b><span>${t('tasks waiting')}</span></div>
      <div class="figure"><b>${fmt(o.doneWeek)}</b><span>${t('tasks done this week')}</span></div>
      <div class="figure"><b>${fmt(s.observations)}</b><span>${t('observations')}</span></div>
      <div class="figure"><b>${fmt(s.summaries)}</b><span>${t('session summaries')}</span></div>
      <div class="figure"><b>${fmt(s.notes)}</b><span>${t('notes')}</span></div>
    </div>
    <h2>${t('Activity')}</h2>${activityStrip(o.activity)}
    <div class="two">
      <div><h2>${t('Open tasks')}</h2>${o.openTasks.length ? html`<ul class="rows">${o.openTasks.map(taskRow)}</ul>` : html`<p class="empty">${tr('No open tasks. Ask Claude to track work with <code>task_add</code>, or add one under Tasks.')}</p>`}
        <h2>${t('Latest sessions')}</h2><ul class="rows">${o.recentSessions.map((x) => html`<li><span class="ref num">${timeOf(x.started_at)}</span>
          <a class="title" href="#/session/${encodeURIComponent(x.session_id)}">${clip(x.first_request || x.first_prompt || t('(no prompt)'), 110)}</a>
          <span class="side">${ago(x.started_at)}</span><span class="sub">${x.project}${x.device ? ` · ${x.device}` : ''} · ${t('{n} prompts', { n: x.prompt_counter })} · ${t('{n} observations', { n: x.obs })}</span></li>`)}</ul></div>
      <div><h2>${t('Active projects')}</h2><ul class="files">${o.projects.map((p) => html`<li><a href="#/project/${encodeURIComponent(p.project)}">${p.project}</a><span class="muted">${ago(p.last)}</span></li>`)}</ul>
        ${o.devices.length ? html`<h2>${t('Machines')}</h2><ul class="files">${o.devices.map((d) => html`<li><span>${d.device}</span><span class="muted num">${fmt(d.n)} · ${ago(d.last)}</span></li>`)}</ul>` : ''}
        ${s.unsynced ? html`<p class="muted">${t('{n} records not yet pushed to the shared server.', { n: fmt(s.unsynced) })}</p>` : ''}</div>
    </div>`;
}

async function projectsView() {
  const rows = await api('/api/projects');
  view.innerHTML = html`<h1 class="page">${t('Projects')}</h1><p class="lede">${t('One card per working folder. Open one for its brief, tasks, notes and history.')}</p>
    <input type="search" id="pfilter" placeholder="${t('Filter projects')}" aria-label="${t('Filter projects')}" style="max-width:320px;margin-bottom:16px">
    <div class="grid" id="pgrid">${rows.map((p) => {
      const total = p.openTasks + p.doneTasks;
      return html`<article class="card" data-name="${p.project.toLowerCase()}"><a class="cover" href="#/project/${encodeURIComponent(p.project)}" aria-label="${p.project}"></a>
        <h3>${p.project}</h3><div class="meta"><span>${t('{n} observations', { n: fmt(p.obs) })}</span><span>${t('{n} sessions', { n: fmt(p.sums) })}</span><span>${t('last {when}', { when: ago(p.last) })}</span></div>
        <div class="meta"><span>${t('{open} open · {done} done', { open: p.openTasks, done: p.doneTasks })}</span><span>${t('{n} notes', { n: p.notes })}</span></div>
        ${total ? html`<div class="bar" title="${t('{done} of {total} tasks done', { done: p.doneTasks, total })}"><span style="width:${Math.round((p.doneTasks / total) * 100)}%"></span></div>` : ''}</article>`;
    })}</div>`;
  $('#pfilter').addEventListener('input', (e) => {
    const v = e.target.value.toLowerCase();
    for (const c of view.querySelectorAll('.card')) c.hidden = !c.dataset.name.includes(v);
  });
}

async function projectView(name) {
  const p = await api(`/api/project?${q({ name })}`);
  const open = p.tasks.filter((x) => ['todo', 'doing', 'blocked'].includes(x.status));
  view.innerHTML = html`<p><a href="#/projects" class="muted">${t('Projects')}</a></p><h1 class="page">${p.project}</h1>
    <p class="lede">${t('{obs} observations · {sums} sessions · since {first} · last {last}', { obs: fmt(p.obs), sums: fmt(p.sums), first: dayOf(p.first), last: ago(p.last) })}</p>
    ${activityStrip(p.activity, 364)}
    <div class="two"><div>
      <h2>${t('Brief')}</h2>${p.brief ? html`<div class="brief">${p.brief.body}</div><p class="muted">${t('Generated {when}', { when: ago(p.brief.generated_at) })}${p.brief.model ? t(' by {model}', { model: p.brief.model }) : ''}${t('. Claude reads this at the start of every session.')}</p>`
        : html`<p class="empty">${t('No brief yet. It is written by the local LLM after enough sessions.')}</p>`}
      <h2>${t('Open tasks')}</h2>${open.length ? html`<ul class="rows">${open.map(taskRow)}</ul>` : html`<p class="muted">${t('None.')}</p>`}
      <h2>${t('Recent sessions')}</h2><ul class="rows">${p.recent.map((s) => html`<li>${refLink(`S${s.id}`)}<span class="title" data-ref="S${s.id}">${clip(s.request, 120)}</span>
        <span class="side">${dayOf(s.created_at)}</span>${s.completed ? html`<span class="sub">${clip(s.completed, 180)}</span>` : ''}</li>`)}</ul>
      <p><a href="#/timeline?project=${encodeURIComponent(p.project)}">${t('Full timeline for {project}', { project: p.project })}</a></p>
      <p><a href="/api/export?${q({ project: p.project })}" download>${t('Export notes and tasks (Markdown)')}</a></p>
    </div><div>
      ${p.review?.flags?.length ? html`<h2>${t('Notes to check')}</h2><ul class="rows">${p.review.flags.map((f) => html`<li>${f.ids.map((id) => refLink(id))} ${typeTag(f.kind)}<span class="sub">${f.reason}</span></li>`)}</ul>
        <p class="muted">${t('Local LLM review of {day}.', { day: dayOf(p.review.at) })}</p>` : ''}
      <h2>${t('Notes')}</h2>${p.notes.length ? html`<ul class="files">${p.notes.map((n) => html`<li><a href="#" data-ref="I${n.id}">${n.title}</a><span class="muted">${ago(n.updated_at)}</span></li>`)}</ul>` : html`<p class="muted">${t('None.')}</p>`}
      <h2>${t('Most-edited files')}</h2><ul class="files">${p.files.map((f) => html`<li><span title="${f.file}">${f.file}</span><span class="num muted">${f.n}</span></li>`)}</ul>
      ${p.branches.length ? html`<h2>${t('Branches')}</h2><ul class="files">${p.branches.map((b) => html`<li><span>${b.branch}</span><span class="muted">${ago(b.last)}</span></li>`)}</ul>` : ''}
      <h2>${t('Kinds of observation')}</h2><p>${p.types.map((x) => html`${typeTag(x.type || 'other')} <span class="num muted">${x.n}</span> &nbsp;`)}</p>
    </div></div>`;
}

async function timelineView(params) {
  const project = params.get('project') || '';
  const kinds = params.get('kinds') || 'obs,sum,event';
  const projects = await api('/api/projects');
  view.innerHTML = html`<h1 class="page">${t('Timeline')}</h1><p class="lede">${t('What happened, newest first. Filled dots are session summaries, red squares are note and task changes.')}</p>
    <div class="toolbar"><select id="tproject" aria-label="${t('Project')}"><option value="">${t('All projects')}</option>${projects.map((p) => html`<option ${p.project === project ? raw('selected') : ''}>${p.project}</option>`)}</select>
      ${[['obs', 'Observations'], ['sum', 'Summaries'], ['event', 'Notes & tasks']].map(([k, l]) => html`<button class="chip" data-kind="${k}" aria-pressed="${kinds.includes(k)}">${t(l)}</button>`)}</div>
    <div class="spine" id="spine"></div><button class="secondary more" id="more" hidden>${t('Show older')}</button>`;
  const go = (next) => { location.hash = `#/timeline?${q(next)}`; };
  $('#tproject').addEventListener('change', (e) => go({ project: e.target.value, kinds }));
  for (const b of view.querySelectorAll('[data-kind]')) {
    b.addEventListener('click', () => {
      const set = new Set(kinds.split(','));
      set.has(b.dataset.kind) ? set.delete(b.dataset.kind) : set.add(b.dataset.kind);
      go({ project, kinds: [...set].join(',') || 'obs' });
    });
  }
  let lastDay = null;
  let dayEl = null;
  const load = async (before) => {
    const { rows, next } = await api(`/api/feed?${q({ project, kinds, before, limit: 80 })}`);
    for (const r of rows) {
      const d = dayOf(r.at);
      if (d !== lastDay) {
        lastDay = d;
        dayEl = document.createElement('section');
        dayEl.className = 'day';
        dayEl.innerHTML = html`<h3>${d.slice(5)}<small>${weekday(r.at)}</small></h3>`.s;
        $('#spine').append(dayEl);
      }
      const e = document.createElement('div');
      e.className = `entry ${r.kind}`;
      const ref = refOf(r);
      e.innerHTML = html`<span class="when">${timeOf(r.at)}</span>${refLink(ref)} ${typeTag(r.kind === 'sum' ? '' : r.type)}
        <span class="t" data-ref="${ref}">${clip(r.title || t('(untitled)'), 140)}</span>
        <div class="d">${[!project && r.project, r.device, r.git_branch, r.subtitle && clip(r.subtitle, 160)].filter(Boolean).join(' · ')}</div>`.s;
      dayEl.append(e);
    }
    if (!rows.length && !before) $('#spine').innerHTML = html`<p class="empty">${t('Nothing recorded yet for this filter.')}</p>`.s;
    $('#more').hidden = !next;
    $('#more').onclick = () => load(next);
  };
  await load();
}

const COLUMNS = [['todo', 'To do'], ['doing', 'Doing'], ['blocked', 'Blocked'], ['done', 'Done']];
async function projectOptions(selected) {
  const projects = await api('/api/projects');
  return html`<option value="">${t('No project')}</option>${projects.map((p) => html`<option ${p.project === selected ? raw('selected') : ''}>${p.project}</option>`)}`;
}

const taskCard = (task, showProject) => html`<li class="task p${task.priority}" data-drag="1" data-id="${task.id}"><span class="t" data-ref="I${task.id}">${task.title}</span>
  <div class="meta">${refLink(`I${task.id}`)}${showProject && task.project ? html`<span>${task.project}</span>` : ''}${task.due_at ? html`<span>${t('due {day}', { day: dayOf(task.due_at) })}</span>` : ''}<span>${ago(task.updated_at)}</span></div></li>`;

// Drag a card to another column of its board to change its status. Pointer events, not HTML5 drag and drop: those
// never fire on touch screens and stall in some embedded browsers. Mouse: drag past a few pixels. Touch: hold the
// card for a moment, then drag (a plain swipe keeps scrolling the page). Bound once on the view; acts on any board.
let dragBound = false;
function enableDrag(root) {
  if (dragBound) return;
  dragBound = true;
  let drag = null;
  const columnAt = (x, y) => document.elementFromPoint(x, y)?.closest('[data-status]');
  const mark = (col) => {
    for (const c of root.querySelectorAll('.drop')) if (c !== col) c.classList.remove('drop');
    if (col && col.closest('.board') === drag.board && col !== drag.from) col.classList.add('drop');
  };
  const start = () => {
    drag.active = true;
    drag.li.classList.add('dragging');
    try { drag.li.setPointerCapture(drag.pointer); } catch { /* pointer already gone */ }
  };
  const end = () => {
    if (!drag) return;
    clearTimeout(drag.hold);
    drag.li.classList.remove('dragging');
    for (const c of root.querySelectorAll('.drop')) c.classList.remove('drop');
    drag = null;
  };
  root.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li[data-drag]');
    if (!li || e.button !== 0 || e.target.closest('a')) return;
    const from = li.closest('[data-status]');
    drag = { li, from, board: from?.closest('.board'), pointer: e.pointerId, x: e.clientX, y: e.clientY, active: false, touch: e.pointerType === 'touch' };
    if (drag.touch) drag.hold = setTimeout(() => drag && start(), 350);
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (!drag.active) {
      if (drag.touch) { if (moved > 8) end(); return; } // a swipe before the hold: let the page scroll
      if (moved < 6) return;
      start();
    }
    e.preventDefault();
    mark(columnAt(e.clientX, e.clientY));
  });
  // While a touch drag is active the page must not scroll under the finger.
  root.addEventListener('touchmove', (e) => { if (drag?.active) e.preventDefault(); }, { passive: false });
  root.addEventListener('pointercancel', end);
  root.addEventListener('pointerup', async (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const { active, li, from, board } = drag;
    const col = active ? columnAt(e.clientX, e.clientY) : null;
    end();
    if (!active) return;
    // The click that ends a drag must not open the card's side panel.
    const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
    root.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => root.removeEventListener('click', swallow, { capture: true }), 0);
    if (!col || col === from || col.closest('.board') !== board) return;
    try { await api('/api/items/update', { id: Number(li.dataset.id), patch: { status: col.dataset.status } }); } catch (err) { alertLine(err.message); }
    route();
  });
}

const alertLine = (msg) => { const p = $('#board-error'); if (p) p.textContent = msg; };

async function tasksView(params) {
  const project = params.get('project') || '';
  const { result: tasks } = await api('/api/items/list', { kind: 'task', project: project || undefined, limit: 500 });
  const opts = await projectOptions(project);
  const column = (st, label, rows, showProject) => html`<section class="col" data-status="${st}"><h3><span>${t(label)}</span><span class="num">${rows.length}</span></h3>
    <ol>${rows.slice(0, st === 'done' ? 30 : 200).map((x) => taskCard(x, showProject))}</ol></section>`;
  const inColumn = (st) => (x) => x.status === st || (st === 'done' && x.status === 'cancelled');
  let body;
  if (project) {
    body = html`<div class="board">${COLUMNS.map(([st, label]) => column(st, label, tasks.filter(inColumn(st)), false))}</div>`;
  } else {
    // Every project: one lane per project with open tasks, busiest first; done tasks of the last 7 days.
    const recent = Date.now() - 7 * 24 * 3600 * 1000;
    const lanes = new Map();
    for (const x of tasks) {
      const open = ['todo', 'doing', 'blocked'].includes(x.status);
      if (!open && !(x.status === 'done' && (x.completed_at || x.updated_at) >= recent)) continue;
      const key = x.project || '';
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push(x);
    }
    const openCount = (rows) => rows.filter((x) => x.status !== 'done').length;
    const sorted = [...lanes.entries()].filter(([, l]) => openCount(l)).sort((a, b) => openCount(b[1]) - openCount(a[1]));
    body = sorted.length ? html`<div class="lanes">${sorted.map(([name, rows]) => html`<section class="lane"><h2><a href="#/tasks?${q({ project: name })}">${name || t('No project')}</a>
        <span class="num muted">${t('{n} open', { n: openCount(rows) })}</span></h2>
      <div class="board">${COLUMNS.map(([st, label]) => column(st, st === 'done' ? 'Done (7 days)' : label, rows.filter(inColumn(st)), false))}</div></section>`)}</div>`
      : html`<p class="empty">${t('No open tasks.')}</p>`;
  }
  view.innerHTML = html`<h1 class="page">${t('Tasks')}</h1><p class="lede">${tr('Durable to-dos Claude and you share across sessions and machines. Drag a card to another column to change its status; Claude moves them with <code>task_update</code>.')}</p>
    <form class="composer" id="new-task"><div class="line"><input type="text" name="title" placeholder="${t('New task, as an action')}" aria-label="${t('New task')}" required>
      <select name="project" aria-label="${t('Project')}">${opts}</select><select name="priority" aria-label="${t('Priority')}"><option value="2">${t('Normal')}</option><option value="1">${t('High')}</option><option value="3">${t('Low')}</option></select>
      <button type="submit">${t('Add task')}</button></div></form>
    <div class="toolbar"><select id="filter-project" aria-label="${t('Show project')}"><option value="">${t('All projects, by project')}</option>${raw(opts.s.replace(/^<option value="">[^<]*<\/option>/, ''))}</select>
      ${project ? html`<a class="muted" href="/api/export?${q({ project })}" download>${t('Export notes and tasks (Markdown)')}</a>` : ''}</div>
    <p id="board-error" class="error" role="alert"></p>${body}`;
  enableDrag(view);
  $('#filter-project').value = project;
  $('#filter-project').addEventListener('change', (e) => { location.hash = `#/tasks?${q({ project: e.target.value })}`; });
  $('#new-task').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/api/items/add', { kind: 'task', title: f.get('title'), project: f.get('project') || null, priority: Number(f.get('priority')) });
    route();
  });
}

async function notesView(params) {
  const project = params.get('project') || '';
  const { result: notes } = await api('/api/items/list', { kind: 'note', project: project || undefined, limit: 500 });
  const opts = await projectOptions(project);
  view.innerHTML = html`<h1 class="page">${t('Notes')}</h1><p class="lede">${tr('Decisions, conventions and gotchas worth keeping. Claude writes them with <code>note_add</code> and reads them at session start.')}</p>
    <form class="composer" id="new-note"><input type="text" name="title" placeholder="${t('Note title')}" aria-label="${t('Note title')}" required>
      <textarea name="body" placeholder="${t('Details')}" aria-label="${t('Details')}"></textarea>
      <div class="line"><select name="project" aria-label="${t('Project')}">${opts}</select><button type="submit">${t('Save note')}</button></div></form>
    ${notes.length ? html`<div class="grid">${notes.map((n) => html`<article class="card"><a class="cover" href="#" data-ref="I${n.id}" aria-label="${n.title}"></a>
      <h3>${n.title}</h3><p class="muted">${clip(n.body, 180)}</p><div class="meta">${refLink(`I${n.id}`)}<span>${n.project || t('no project')}</span><span>${ago(n.updated_at)}</span>${n.status === 'archived' ? html`<span>${t('archived')}</span>` : ''}</div></article>`)}</div>`
      : html`<p class="empty">${t('No notes yet.')}</p>`}`;
  $('#new-note').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/api/items/add', { kind: 'note', title: f.get('title'), body: f.get('body') || null, project: f.get('project') || null });
    route();
  });
}

async function searchView(params) {
  const query = params.get('q') || '';
  const kind = params.get('kind') || 'all';
  view.innerHTML = html`<h1 class="page">${t('Search')}</h1><p class="lede">${t('The same search Claude uses: full-text, plus meaning when the embedding model is available. Words match by prefix.')}</p>
    <form class="toolbar" id="sform"><input type="search" name="q" value="${query}" placeholder="${t('What are you looking for?')}" aria-label="${t('Search')}" autofocus>
      <select name="kind" aria-label="${t('Kind')}">${[['all', 'Everything'], ['observations', 'Observations'], ['summaries', 'Summaries'], ['notes', 'Notes'], ['tasks', 'Tasks']].map(([v, l]) => html`<option value="${v}" ${v === kind ? raw('selected') : ''}>${t(l)}</option>`)}</select>
      <button type="submit">${t('Search')}</button></form><div id="results"></div>`;
  $('#sform').addEventListener('submit', (e) => { e.preventDefault(); const f = new FormData(e.target); location.hash = `#/search?${q({ q: f.get('q'), kind: f.get('kind') })}`; });
  if (!query) return;
  const { result } = await api('/api/search', { query, kind, limit: 100 });
  $('#results').innerHTML = (result.length ? html`<ul class="rows">${result.map((r) => html`<li>${refLink(refOf(r))}<span class="title" data-ref="${refOf(r)}">${clip(r.title, 150)}</span>
    <span class="side">${dayOf(r.created_at)}</span><span class="sub">${r.project} · ${t(r.type)}</span></li>`)}</ul>` : html`<p class="empty">${t('No matches for “{query}”.', { query })}</p>`).s;
}

async function sessionsView() {
  const rows = await api('/api/sessions?limit=150');
  view.innerHTML = html`<h1 class="page">${t('Sessions')}</h1><p class="lede">${t('Every Claude Code conversation, with the machine and branch it ran on.')}</p>
    <ul class="rows">${rows.map((x) => html`<li><span class="ref num">${dayOf(x.started_at).slice(5)}</span>
      <a class="title" href="#/session/${encodeURIComponent(x.session_id)}">${clip(x.first_request || x.first_prompt || t('(no prompt)'), 120)}</a>
      <span class="side">${ago(x.started_at)}</span><span class="sub">${[x.project, x.device, x.git_branch, t('{n} prompts', { n: x.prompt_counter }), t('{n} observations', { n: x.obs })].filter(Boolean).join(' · ')}</span></li>`)}</ul>`;
}

async function sessionView(id) {
  const s = await api(`/api/session?${q({ id })}`);
  const byPrompt = new Map();
  for (const o of s.observations) { if (!byPrompt.has(o.prompt_number)) byPrompt.set(o.prompt_number, []); byPrompt.get(o.prompt_number).push(o); }
  const sumBy = new Map(s.summaries.map((x) => [x.prompt_number, x]));
  view.innerHTML = html`<p><a href="#/sessions" class="muted">${t('Sessions')}</a></p><h1 class="page">${s.session.project}</h1>
    <p class="lede">${[dayOf(s.session.started_at) + ' ' + timeOf(s.session.started_at), s.session.device, s.session.git_branch, s.session.cwd].filter(Boolean).join(' · ')}</p>
    <div class="spine">${s.prompts.map((p) => html`<section class="day"><h3>#${p.prompt_number}<small>${timeOf(p.created_at)}</small></h3>
      <div class="entry"><div class="t">${clip(p.text, 400)}</div></div>
      ${(byPrompt.get(p.prompt_number) || []).map((o) => html`<div class="entry">${refLink(`${o.id}`)} ${typeTag(o.type)} <span class="t" data-ref="${o.id}">${o.title}</span></div>`)}
      ${sumBy.get(p.prompt_number) ? html`<div class="entry sum">${refLink(`S${sumBy.get(p.prompt_number).id}`)} <span class="t" data-ref="S${sumBy.get(p.prompt_number).id}">${clip(sumBy.get(p.prompt_number).completed || t('Summary'), 200)}</span></div>` : ''}
    </section>`)}</div>`;
}

// --- router -----------------------------------------------------------------------------------------
const TITLES = { overview: 'Progress', projects: 'Projects', project: 'Projects', timeline: 'Timeline', tasks: 'Tasks', notes: 'Notes', search: 'Search', sessions: 'Sessions', session: 'Sessions' };
async function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const [name = 'overview', arg] = path.split('/');
  for (const a of document.querySelectorAll('[data-nav]')) {
    const on = a.dataset.nav === name || (name === 'project' && a.dataset.nav === 'projects') || (name === 'session' && a.dataset.nav === 'sessions');
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  }
  const views = {
    overview: overviewView, projects: projectsView, project: () => projectView(decodeURIComponent(arg)), timeline: timelineView,
    tasks: tasksView, notes: notesView, search: searchView, sessions: sessionsView, session: () => sessionView(decodeURIComponent(arg)),
  };
  try {
    await (views[name] || overviewView)(params);
  } catch (err) {
    if (err.message !== LOGIN_REQUIRED) view.innerHTML = html`<p class="empty">${t('Could not load this page: {error}', { error: err.message })}</p>`.s;
  }
  document.title = `open-mem · ${t(TITLES[name] || 'Progress')}`;
}

async function start() {
  const me = await api('/api/me');
  if (!me.authenticated) return showLogin();
  $('#login').hidden = true;
  $('#app').hidden = false;
  route();
}
window.addEventListener('hashchange', route);
start();

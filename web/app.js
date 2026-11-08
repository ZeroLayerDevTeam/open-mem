// open-mem web viewer: hash routes, server-side paging, escaped templates. No framework and no build step.
// The URL holds every filter and page, so back/forward, reload and shared links restore the same view.
import { LANGS, THEMES, lang, setLang, setTheme, t, theme, translateStatic } from './i18n.js';
import {
  $, $$, LOGIN_REQUIRED, ago, api, cached, clip, dateLong, dateShort, dateTime, debounce, duration, excerpt, fmt, highlight, html, icon, list, md,
  metaItems, pager, qs, raw, refLink, refOf, timeOf, toast, tr, typeTag,
} from './ui.js';

const view = $('#view');
const enc = encodeURIComponent;
const DAY = 864e5;
const OPEN = ['todo', 'doing', 'blocked'];

// --- language and theme ----------------------------------------------------------------------------------------
function fillPrefs() {
  for (const sel of $$('select[data-pref]')) {
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
    if (!$('#app').hidden) { current = null; route(); }
  }
});
translateStatic();
fillPrefs();

// --- login -------------------------------------------------------------------------------------------------------
function showLogin() {
  closeDrawer();
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#token').focus();
}
window.addEventListener('om:login', showLogin);
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { body: { token: $('#token').value.trim() } });
    $('#token').value = '';
    start();
  } catch (err) { $('#login-error').textContent = t(err.message); }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', { body: {} }).catch(() => {}); showLogin(); });

// --- side menu (off-canvas on narrow screens), global search, keyboard ------------------------------------------
const side = $('#side');
function setMenu(open) {
  side.classList.toggle('open', open);
  $('#scrim').hidden = !open;
  $('#menu').setAttribute('aria-expanded', String(open));
  if (open) $('.nav a[aria-current]', side)?.focus();
}
$('#menu').addEventListener('click', () => setMenu(!side.classList.contains('open')));
$('#scrim').addEventListener('click', () => setMenu(false));

$('#omni').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#omni-input');
  const q = input.value.trim();
  input.value = '';
  input.blur();
  location.hash = `#/search?${qs({ q })}`;
});
const typing = (el) => Boolean(el?.closest?.('input, textarea, select, [contenteditable="true"]'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && side.classList.contains('open')) setMenu(false);
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target) && !drawer.open) {
    e.preventDefault();
    const input = $('#q-main') || $('#omni-input');
    input.focus();
    input.select();
  }
});

// --- record drawer --------------------------------------------------------------------------------------------
const drawer = $('#drawer');
let drawerToken = 0;
function closeDrawer() { if (drawer.open) drawer.close(); }
$('#drawer-close').addEventListener('click', closeDrawer);
drawer.addEventListener('click', (e) => { if (e.target === drawer) closeDrawer(); }); // the backdrop
$('#drawer-copy').addEventListener('click', async (e) => {
  const ref = e.currentTarget.dataset.ref;
  try { await navigator.clipboard.writeText(ref); toast(t('Copied {ref}', { ref })); } catch { toast(ref); }
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); toast(t('Copied')); } catch { toast(t('Could not copy')); }
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-ref]');
  if (!a) return;
  e.preventDefault();
  openRecord(a.dataset.ref);
});

const section = (label, body) => (body ? html`<h3>${t(label)}</h3>${body}` : '');
const bullets = (v) => { const a = list(v); return a.length ? html`<ul class="bullets">${a.map((x) => html`<li>${x}</li>`)}</ul>` : ''; };
const files = (v) => { const a = list(v); return a.length ? html`<ul class="files">${a.map((x) => html`<li>${x}</li>`)}</ul>` : ''; };
const sessionLink = (id) => html`<a href="#/session/${enc(id)}" class="mono">${clip(id, 24)}</a>`;

function factsList(r) {
  const rows = [
    ['Project', r.project && html`<a href="#/project/${enc(r.project)}">${r.project}</a>`], ['Directory', (r.directory || r.cwd) && html`<span class="mono">${r.directory || r.cwd}</span>`],
    ['Device', r.device], ['Branch', r.git_branch], ['Commit', r.git_commit && html`<span class="mono">${String(r.git_commit).slice(0, 12)}</span>`],
    ['Tool', r.tool], ['Model', r.model], ['Session', r.session_id && sessionLink(r.session_id)], ['Prompt', r.prompt_number && `#${r.prompt_number}`],
    ['Created', r.created_at && dateTime(r.created_at)], ['Updated', r.updated_at && dateTime(r.updated_at)], ['Source', r.source],
  ].filter(([, v]) => v);
  return html`<dl class="facts">${rows.map(([k, v]) => html`<dt>${t(k)}</dt><dd>${v}</dd>`)}</dl>`;
}

async function openRecord(ref) {
  const my = ++drawerToken;
  if (!drawer.open) drawer.showModal();
  $('#drawer-title').innerHTML = html`<span class="ref">${ref}</span>`.s;
  $('#drawer-copy').hidden = true;
  const body = $('#drawer-body');
  body.innerHTML = skeleton(6).s;
  body.scrollTop = 0;
  let r;
  try { r = await api(`/api/record?${qs({ ref })}`); } catch (err) {
    if (my === drawerToken) body.innerHTML = html`<p class="error-box">${err.message}</p>`.s;
    return;
  }
  if (my !== drawerToken) return;
  const realRef = refOf(r);
  $('#drawer-copy').dataset.ref = realRef;
  $('#drawer-copy').hidden = false;
  if (r.kind === 'sum') {
    $('#drawer-title').innerHTML = html`<span class="ref">${realRef}</span><span class="tag" data-type="summary">${t('session summary')}</span>`.s;
    body.innerHTML = html`<h2>${r.request || t('Session summary')}</h2>
      ${[['Investigated', r.investigated], ['Learned', r.learned], ['Completed', r.completed], ['Next steps', r.next_steps], ['Notes', r.notes]]
        .map(([k, v]) => section(k, v && html`<div class="prose">${md(v)}</div>`))}
      ${section('Files modified', files(r.files_modified))}${factsList(r)}`.s;
  } else if (r.kind === 'item') {
    $('#drawer-title').innerHTML = html`<span class="ref">${realRef}</span>${typeTag(r.item_kind)}<span class="status" data-s="${r.status}">${t(r.status)}</span>`.s;
    body.innerHTML = html`${itemEditor(r)}${factsList(r)}
      ${section('History', html`<ul class="history">${(r.events || []).slice().reverse().map((e) => html`<li><time>${dateTime(e.at)}</time>${t(e.event)}${e.to_status ? ` → ${t(e.to_status)}` : ''}${e.detail ? `: ${e.detail}` : ''}${e.device ? html` <span class="muted">(${e.device})</span>` : ''}</li>`)}</ul>`)}`.s;
    wireItemEditor(r);
  } else {
    $('#drawer-title').innerHTML = html`<span class="ref">${realRef}</span>${typeTag(r.type || 'observation')}`.s;
    body.innerHTML = html`<h2>${r.title || t('(untitled)')}</h2>${r.subtitle ? html`<p class="subtitle">${r.subtitle}</p>` : ''}
      ${r.narrative ? html`<div class="prose">${md(r.narrative)}</div>` : ''}
      ${section('Facts', bullets(r.facts))}
      ${section('Concepts', list(r.concepts).length ? html`<div class="chips">${list(r.concepts).map((c) => html`<a class="chip" href="#/search?${qs({ q: c })}">${c}</a>`)}</div>` : '')}
      ${section('Files modified', files(r.files_modified))}${section('Files read', files(r.files_read))}${factsList(r)}
      <div class="drawer-actions"><button class="btn" type="button" data-around="${r.id}">${icon('timeline')}${t('What happened around this')}</button>
        ${r.session_id ? html`<a class="btn ghost" href="#/session/${enc(r.session_id)}">${icon('sessions')}${t('Open session')}</a>` : ''}</div>
      <div id="around"></div>`.s;
    $('[data-around]', body).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const res = await api('/api/timeline', { body: { anchor: btn.dataset.around, before: 6, after: 6 } });
      $('#around').innerHTML = html`<h3>${t('Around this record')}</h3><ul class="list compact">${(res.result || []).map((x) => html`<li>
        <div class="lead">${refLink(refOf(x))}${x.kind === 'sum' ? html`<span class="tag" data-type="summary">${t('session summary')}</span>` : typeTag(x.type)}<span>${dateTime(x.created_at)}</span></div>
        <a class="title" href="#" data-ref="${refOf(x)}">${x.anchor ? html`<strong>${clip(x.title, 140)}</strong>` : clip(x.title, 140)}</a></li>`)}</ul>`.s;
      btn.remove();
    });
  }
}

function itemEditor(r) {
  const isTask = r.item_kind === 'task';
  const statuses = isTask ? ['todo', 'doing', 'blocked', 'done', 'cancelled'] : ['active', 'archived'];
  return html`<form class="composer" id="item-form">
    <input type="text" name="title" value="${r.title}" aria-label="${t('Title')}" required>
    <textarea name="body" aria-label="${t('Details')}" placeholder="${t('Details')}">${r.body || ''}</textarea>
    <div class="row">
      <select name="status" aria-label="${t('Status')}">${statuses.map((s) => html`<option value="${s}" ${s === r.status ? raw('selected') : ''}>${t(s)}</option>`)}</select>
      ${isTask ? html`<select name="priority" aria-label="${t('Priority')}">${PRIORITIES.map(([v, l]) => html`<option value="${v}" ${v === r.priority ? raw('selected') : ''}>${t(l)}</option>`)}</select>
        <input type="date" name="due" aria-label="${t('Due date')}" value="${r.due_at ? new Date(r.due_at).toISOString().slice(0, 10) : ''}">` : ''}
    </div>
    <input type="text" name="comment" placeholder="${t('Progress comment (optional)')}" aria-label="${t('Comment')}">
    <div class="row"><button type="submit" class="btn primary">${t('Save changes')}</button><span class="grow"></span><button type="button" class="btn danger" id="item-delete">${t('Delete')}</button></div>
    <p class="form-error" id="item-error" role="alert"></p>
  </form>`;
}
const PRIORITIES = [[1, 'High'], [2, 'Normal'], [3, 'Low']];

function wireItemEditor(r) {
  const form = $('#item-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const patch = { title: f.get('title'), body: f.get('body'), status: f.get('status'), comment: f.get('comment') || undefined };
    if (f.has('priority')) patch.priority = Number(f.get('priority'));
    if (f.has('due')) patch.due = f.get('due') || null;
    try {
      await api('/api/items/update', { body: { id: r.id, patch } });
      toast(t('Saved'));
      openRecord(`I${r.id}`);
      refresh();
    } catch (err) { $('#item-error').textContent = err.message; }
  });
  $('#item-delete').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = t('Click again to delete for good'); return; }
    await api('/api/items/delete', { body: { id: r.id } });
    closeDrawer();
    toast(t('Deleted'));
    refresh();
  });
}

// --- shared bits of the pages -----------------------------------------------------------------------------------
const head = (title, lede, actions = '') => html`<header class="page-head"><div><h1>${title}</h1>${lede ? html`<p class="lede">${lede}</p>` : ''}</div>${actions}</header>`;
const kpi = (n, label, href, tone) => html`<a class="kpi" href="${href}" ${tone ? raw(`data-tone="${tone}"`) : ''}><b>${fmt(n)}</b><span>${label}</span></a>`;
const stat = (value, label) => html`<div class="kpi"><b>${value}</b><span>${label}</span></div>`;
const emptyPanel = (msg) => html`<p class="empty">${msg}</p>`;
const skeleton = (n = 8) => html`<div class="skel" aria-hidden="true">${Array.from({ length: n }, () => raw('<i></i>'))}</div>`;
const option = (value, label, selected) => html`<option value="${value}" ${selected ? raw('selected') : ''}>${label}</option>`;
const projectOptions = (names, selected, none = t('All projects')) => html`${option('', none, !selected)}${names.map((p) => option(p, p, p === selected))}`;
const meta = (items) => (items.some(Boolean) ? html`<div class="meta">${items}</div>` : '');

function heatmap(rows, weeks) {
  const counts = new Map(rows.map((r) => [r.day, r.n]));
  const max = Math.max(1, ...rows.map((r) => r.n));
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const start = today - (((new Date(today).getUTCDay() + 6) % 7) + (weeks - 1) * 7) * DAY; // Monday, `weeks` columns back
  const utc = { timeZone: 'UTC' };
  const loc = document.documentElement.lang;
  const cells = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const first = new Date(start + w * 7 * DAY);
    if (first.getUTCMonth() !== lastMonth) {
      lastMonth = first.getUTCMonth();
      if (w > 0 || first.getUTCDate() <= 21) cells.push(html`<span class="mo" style="grid-column:${w + 2}">${first.toLocaleDateString(loc, { ...utc, month: 'short' })}</span>`);
    }
    for (let d = 0; d < 7; d++) {
      const ms = start + (w * 7 + d) * DAY;
      if (ms > today) break;
      const n = counts.get(new Date(ms).toISOString().slice(0, 10)) || 0;
      const l = n ? Math.max(1, Math.ceil(Math.sqrt(n / max) * 4)) : 0;
      cells.push(html`<i style="grid-column:${w + 2};grid-row:${d + 2}" data-l="${l}" ${ms === today ? raw('class="today"') : ''} title="${t('{day}: {n} records', { day: new Date(ms).toLocaleDateString(loc, { ...utc, dateStyle: 'medium' }), n: fmt(n) })}"></i>`);
    }
  }
  const wd = [0, 2, 4].map((d) => html`<span class="wd" style="grid-row:${d + 2}">${new Date(start + d * DAY).toLocaleDateString(loc, { ...utc, weekday: 'short' })}</span>`);
  return html`<div class="heat-wrap"><div class="heat" style="--weeks:${weeks}" role="img" aria-label="${t('Records per day, last {n} weeks', { n: weeks })}">${wd}${cells}</div></div>
    <div class="heat-legend" aria-hidden="true"><span>${t('Less')}</span>${[0, 1, 2, 3, 4].map((l) => html`<i data-l="${l}"></i>`)}<span>${t('More')}</span></div>`;
}
const scrollHeatToEnd = () => { for (const el of $$('.heat-wrap', view)) el.scrollLeft = el.scrollWidth; };

const statusChip = (s) => html`<span class="status" data-s="${s}">${t(s)}</span>`;
const taskItem = (task, showProject = true) => html`<li>
  <div class="lead">${statusChip(task.status)}${refLink(`I${task.id}`)}${task.priority === 1 ? html`<span class="tag" data-type="bugfix">${t('High')}</span>` : ''}${task.due_at ? html`<span>${t('due {day}', { day: dateShort(task.due_at) })}</span>` : ''}</div>
  <a class="title" href="#" data-ref="I${task.id}">${task.title}</a><span class="aside">${ago(task.updated_at)}</span>
  ${showProject ? meta(metaItems({ project: task.project })) : ''}</li>`;

const sessionTitle = (x) => clip(x.first_request || x.first_prompt || t('(no prompt)'), 160);
const sessionItem = (x, showProject = true) => html`<li>
  <div class="lead"><span class="num">${dateShort(x.started_at)}, ${timeOf(x.started_at)}</span>${x.last_at - x.started_at > 60000 ? html`<span>${duration(x.last_at - x.started_at)}</span>` : ''}</div>
  <a class="title" href="#/session/${enc(x.session_id)}">${sessionTitle(x)}</a><span class="aside">${ago(x.started_at)}</span>
  ${meta(metaItems({ project: showProject && x.project, device: x.device, branch: x.git_branch, extra: [
    html`<span class="meta-item">${icon('terminal')}${t('{n} prompts', { n: fmt(x.prompts) })}</span>`,
    x.obs ? html`<span class="meta-item">${icon('timeline')}${t('{n} observations', { n: fmt(x.obs) })}</span>` : '',
  ] }))}</li>`;

// Filter changes rewrite the URL; typing replaces the history entry instead of adding one per key.
function setParams(patch, { replace = false } = {}) {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const p = new URLSearchParams(query);
  for (const [k, v] of Object.entries(patch)) (v == null || v === '' ? p.delete(k) : p.set(k, v));
  if (!('page' in patch)) p.delete('page');
  const next = `#${path || '/overview'}${p.toString() ? `?${p}` : ''}`;
  if (replace) { history.replaceState(null, '', next); route(); } else location.hash = next;
}
function pageHref(n) {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const p = new URLSearchParams(query);
  if (n > 1) p.set('page', n); else p.delete('page');
  return `#${path}${p.toString() ? `?${p}` : ''}`;
}
const pageOf = (params) => Math.max(1, Number(params.get('page')) || 1);

// Why a queue waits ({ kind, detail } from the drainer), in words. A game shows as its file name.
function pauseText(p) {
  const label = { manual: t('Paused by hand'), marker: t('Another job holds the GPU'), game: t('A game is running'), gpu: t('Not enough free GPU memory'),
    slots: t('Ollama is full with other apps\' models'), slow: t('The LLM is too slow right now, trying again in a few minutes'),
    error: t('The LLM failed, trying again in a few minutes') }[p.kind] || p.kind;
  const detail = p.kind === 'game' ? String(p.detail || '').split(/[\\/]/).pop() : p.detail;
  return detail ? `${label}: ${clip(detail, 120)}` : label;
}

// Queues that wait or work, per machine: a delay in the activity chart must not read as missing work.
function queuesPanel(queues, title = t('Queue'), note = t('Records appear in the activity chart, on the day they were captured, once the queue processes them.'), button = '') {
  if (!queues?.length) return '';
  const row = (q) => {
    const [state, label, why] = q.down ? ['down', t('Waiting for the LLM'), t('Not answering since {when}: {reason}', { when: ago(q.down.since), reason: clip(q.down.reason, 160) })]
      : q.pause ? ['paused', t('Paused'), t('Since {when}: {reason}', { when: ago(q.pause.since), reason: pauseText(q.pause) })]
        : q.pending ? ['work', t('Processing'), ''] : ['ready', t('Ready'), ''];
    return html`<li><div class="lead"><span class="state" data-s="${state}">${label}</span><span class="meta-item">${icon('device')}${q.device}</span>
      <span data-report="${q.at}">${reportText(q.at)}</span></div>
      <span class="title">${q.pending ? t('{n} items in the queue, the oldest from {when}', { n: fmt(q.pending), when: dateTime(q.oldest) }) : t('Queue empty')}</span>
      ${why ? html`<p class="snippet">${why}</p>` : ''}</li>`;
  };
  return html`<section class="panel"><header class="panel-head"><h2>${title}</h2><div class="head-aside"><span class="muted">${note}</span>${button}</div></header>
    <ul class="list compact">${queues.map(row)}</ul></section>`;
}

// A draining machine reports its queue every REPORT_EVERY_S: how old the shown report is, and when the next one is due.
const REPORT_EVERY_S = 30;
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function reportText(at) {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s > 30 * 60) return t('last report {when}', { when: ago(at) });
  if (s >= REPORT_EVERY_S + 15) return t('last report {time} ago', { time: clock(s) });
  return t('last report {time} ago · next in {left}', { time: clock(s), left: clock(Math.max(0, REPORT_EVERY_S - s)) });
}
// Counts the shown reports' age every second, between the page's own reloads.
setInterval(() => { for (const el of $$('[data-report]')) el.textContent = reportText(Number(el.dataset.report)); }, 1000);

// --- progress -----------------------------------------------------------------------------------------------------
const overviewPage = {
  async render({ signal }) {
    const o = await api('/api/overview', { signal });
    const s = o.stats;
    const by = Object.fromEntries(o.tasks.map((x) => [x.status, x.n]));
    const top = Math.max(1, ...o.projects.map((p) => p.obs + p.sums));
    view.innerHTML = html`${head(t('Progress'), t('Everything Claude has remembered across your machines, and the work still open.'), refreshButton())}
      <section class="kpis" aria-label="${t('Summary')}">
        ${kpi(by.doing, t('tasks in progress'), '#/tasks', 'doing')}${kpi((by.todo || 0) + (by.blocked || 0), t('tasks waiting'), '#/tasks')}
        ${kpi(o.doneWeek, t('tasks done this week'), '#/tasks')}${kpi(s.observations, t('observations'), '#/timeline?kinds=obs')}
        ${kpi(s.sessions, t('sessions'), '#/sessions')}${kpi(s.projects, t('projects'), '#/projects')}
      </section>
      ${queuesPanel(o.queues)}
      <section class="panel"><header class="panel-head"><h2>${t('Activity')}</h2><span class="muted">${t('Records per day, last {n} weeks', { n: 53 })}</span></header>${heatmap(o.activity, 53)}</section>
      <div class="cols">
        <section class="panel"><header class="panel-head"><h2>${t('Open tasks')}</h2><a href="#/tasks">${t('All tasks')}</a></header>
          ${o.openTasks.length ? html`<ul class="list compact">${o.openTasks.map((x) => taskItem(x))}</ul>` : emptyPanel(tr('No open tasks. Ask Claude to track work with <code>task_add</code>, or add one under Tasks.'))}</section>
        <section class="panel"><header class="panel-head"><h2>${t('Latest sessions')}</h2><a href="#/sessions">${t('All sessions')}</a></header>
          ${o.recentSessions.length ? html`<ul class="list compact">${o.recentSessions.map((x) => sessionItem(x))}</ul>` : emptyPanel(t('No sessions yet.'))}</section>
      </div>
      <div class="cols">
        <section class="panel"><header class="panel-head"><h2>${t('Active projects')}</h2><a href="#/projects">${t('All projects')}</a></header>
          <ul class="kv">${o.projects.map((p) => html`<li><div class="share"><a class="k" href="#/project/${enc(p.project)}">${p.project}</a>
            <div class="bar"><span style="width:${Math.max(2, Math.round(((p.obs + p.sums) / top) * 100))}%"></span></div></div><span class="v">${ago(p.last)}</span></li>`)}</ul></section>
        <section class="panel"><header class="panel-head"><h2>${t('Machines')}</h2></header>
          ${o.devices.length ? html`<ul class="kv">${o.devices.map((d) => html`<li><span class="k">${icon('device')} ${d.device}</span><span class="v">${t('{n} records', { n: fmt(d.n) })}, ${ago(d.last)}</span></li>`)}</ul>`
            : emptyPanel(t('Records captured from now on carry the machine they came from.'))}
          ${s.unsynced ? html`<p class="foot-note">${t('{n} records not yet pushed to the shared server.', { n: fmt(s.unsynced) })}</p>` : ''}</section>
      </div>`;
    scrollHeatToEnd();
  },
};

// --- projects ---------------------------------------------------------------------------------------------------
const PROJECT_SORT = {
  project: (p) => p.project.toLowerCase(), last: (p) => p.last, obs: (p) => p.obs, sessions: (p) => p.sessions, tasks: (p) => p.openTasks, notes: (p) => p.notes,
};
const projectsPage = {
  rows: [],
  async render(ctx) {
    this.rows = await cached('/api/projects', ctx);
    view.innerHTML = html`${head(t('Projects'), t('One row per working folder. Open one for its brief, tasks, notes and history.'))}
      <div class="toolbar"><input type="search" id="pfilter" placeholder="${t('Filter projects')}" aria-label="${t('Filter projects')}" value="${ctx.params.get('q') || ''}"></div>
      <div id="results"></div>`;
    $('#pfilter').addEventListener('input', debounce((e) => setParams({ q: e.target.value }, { replace: true }), 150));
    this.update(ctx);
  },
  update({ params }) {
    const q = (params.get('q') || '').trim().toLowerCase();
    const sort = PROJECT_SORT[params.get('sort')] ? params.get('sort') : 'last';
    const dir = params.get('dir') || (sort === 'project' ? 'asc' : 'desc');
    const key = PROJECT_SORT[sort];
    const rows = this.rows.filter((p) => p.project.toLowerCase().includes(q))
      .sort((a, b) => { const x = key(a); const y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'asc' ? 1 : -1); });
    const size = 25;
    const page = Math.min(pageOf(params), Math.max(1, Math.ceil(rows.length / size)));
    const th = (k, label, num) => html`<th class="${num ? 'n' : ''}" ${sort === k ? raw(`aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"`) : ''}>
      <button type="button" data-sort="${k}">${label}${icon(sort === k && dir === 'asc' ? 'chevron-up' : 'chevron-down')}</button></th>`;
    const cell = (label, value, cls = 'n') => html`<td class="${cls}"><span class="lbl">${label}</span>${value}</td>`;
    $('#results').innerHTML = (rows.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr>${th('project', t('Project'))}${th('last', t('Last activity'))}${th('obs', t('Observations'), 1)}${th('sessions', t('Sessions'), 1)}${th('tasks', t('Open tasks'), 1)}${th('notes', t('Notes'), 1)}</tr></thead>
      <tbody>${rows.slice((page - 1) * size, page * size).map((p) => html`<tr>
        <td><a class="pname" href="#/project/${enc(p.project)}">${p.project}</a><span class="sub">${t('since {day}', { day: dateShort(p.first) })}</span></td>
        ${cell(t('Last activity'), ago(p.last), '')}${cell(t('Observations'), fmt(p.obs))}${cell(t('Sessions'), fmt(p.sessions))}
        ${cell(t('Open tasks'), p.openTasks + p.doneTasks ? html`<span class="minibar" title="${t('{done} of {total} tasks done', { done: p.doneTasks, total: p.openTasks + p.doneTasks })}"><span class="bar"><span style="width:${Math.round((p.doneTasks / (p.openTasks + p.doneTasks)) * 100)}%"></span></span>${fmt(p.openTasks)}</span>` : '0')}
        ${cell(t('Notes'), fmt(p.notes))}</tr>`)}</tbody></table></div>
      ${pager({ page, pageSize: size, total: rows.length }, pageHref)}`
      : emptyPanel(t('No project matches “{query}”.', { query: q }))).s;
    for (const b of $$('[data-sort]', view)) {
      b.addEventListener('click', () => {
        const k = b.dataset.sort;
        setParams({ sort: k, dir: k === sort ? (dir === 'asc' ? 'desc' : 'asc') : (k === 'project' ? 'asc' : 'desc') });
      });
    }
  },
};

// A file path from the project folder down ("src/app.js" rather than "C:\Users\…\project\src\app.js").
function inProject(file, project) {
  const parts = String(file).split(/[\\/]/);
  const i = parts.findLastIndex((x) => x.toLowerCase() === String(project).toLowerCase());
  return i >= 0 && i < parts.length - 1 ? parts.slice(i + 1).join('/') : file;
}

const projectPage = {
  async render({ arg, signal }) {
    const p = await api(`/api/project?${qs({ name: arg })}`, { signal });
    const open = p.tasks.filter((x) => OPEN.includes(x.status));
    const pq = qs({ project: p.project });
    const panel = (title, link, body) => html`<section class="panel"><header class="panel-head"><h2>${title}</h2>${link || ''}</header>${body}</section>`;
    view.innerHTML = html`<nav class="crumbs"><a href="#/projects">${icon('arrow-left')}${t('Projects')}</a></nav>
      ${head(p.project, t('First record {first}, last activity {last}', { first: dateShort(p.first), last: ago(p.last) }), html`<div class="actions">
        <a class="btn" href="#/timeline?${pq}">${icon('timeline')}${t('Timeline')}</a><a class="btn" href="#/sessions?${pq}">${icon('sessions')}${t('Sessions')}</a>
        <a class="btn ghost" href="/api/export?${pq}" download>${icon('download')}${t('Export')}</a></div>`)}
      <section class="kpis">${kpi(p.obs, t('observations'), `#/timeline?${qs({ project: p.project, kinds: 'obs' })}`)}${kpi(p.sessions, t('sessions'), `#/sessions?${pq}`)}
        ${kpi(p.openTasks, t('open tasks'), `#/tasks?${pq}`, p.openTasks ? 'doing' : '')}${kpi(p.notes, t('notes'), `#/notes?${pq}`)}</section>
      <section class="panel"><header class="panel-head"><h2>${t('Activity')}</h2><span class="muted">${t('Records per day, last {n} weeks', { n: 53 })}</span></header>${heatmap(p.activity, 53)}</section>
      <div class="cols wide-left"><div class="stack">
        ${panel(t('Brief'), p.brief ? html`<span class="muted">${ago(p.brief.generated_at)}</span>` : '', p.brief
          ? html`<div class="prose brief">${md(p.brief.body)}</div><p class="foot-note">${t('Claude reads this at the start of every session.')}${p.brief.model ? ` ${t('Written by {model}.', { model: p.brief.model })}` : ''}</p>`
          : emptyPanel(t('No brief yet. It is written by the local LLM after enough sessions.')))}
        ${panel(t('Open tasks'), html`<a href="#/tasks?${pq}">${t('Task board')}</a>`, open.length ? html`<ul class="list compact">${open.map((x) => taskItem(x, false))}</ul>` : emptyPanel(t('No open tasks.')))}
        ${panel(t('Recent session summaries'), html`<a href="#/sessions?${pq}">${t('All sessions')}</a>`, p.recent.length ? html`<ul class="list compact">${p.recent.map((s) => html`<li>
          <div class="lead">${refLink(`S${s.id}`)}<span>${dateShort(s.created_at)}, ${timeOf(s.created_at)}</span></div>
          <a class="title" href="#" data-ref="S${s.id}">${clip(s.request || t('Session summary'), 160)}</a>
          ${s.completed ? html`<p class="snippet">${excerpt(s.completed, 240)}</p>` : ''}</li>`)}</ul>` : emptyPanel(t('No session summaries yet.')))}
      </div><div class="stack">
        ${p.lessons?.lessons?.length ? panel(t('Repeated mistakes'), html`<button class="btn ghost small" type="button" data-copy="${p.lessons.lessons.map((l) => `- ${l.rule}`).join('\n')}">${t('Copy as list')}</button>`,
          html`<p class="muted">${t("Fixed in two or more sessions (local LLM, {day}). Worth adding to the project's known mistakes.", { day: dateShort(p.lessons.at) })}</p>
          <ul class="list compact">${p.lessons.lessons.map((l) => html`<li><p class="snippet">${l.rule}</p><div class="lead">${l.ids.map((id) => refLink(id))}</div></li>`)}</ul>`) : ''}
        ${p.review?.flags?.length ? panel(t('Notes to check'), html`<span class="muted">${t('Local LLM review of {day}.', { day: dateShort(p.review.at) })}</span>`,
          html`<ul class="list compact">${p.review.flags.map((f) => html`<li><div class="lead">${typeTag(f.kind)}${f.ids.map((id) => refLink(id))}</div><p class="snippet">${f.reason}</p></li>`)}</ul>`) : ''}
        ${panel(t('Notes'), html`<a href="#/notes?${pq}">${t('All notes')}</a>`, p.notes.length
          ? html`<ul class="kv">${p.notes.slice(0, 12).map((n) => html`<li><a class="k" href="#" data-ref="I${n.id}">${n.title}</a><span class="v">${ago(n.updated_at)}</span></li>`)}</ul>` : emptyPanel(t('No notes yet.')))}
        ${p.files.length ? panel(t('Most-edited files'), '', html`<ul class="kv">${p.files.map((f) => html`<li><span class="k path" title="${f.file}">${inProject(f.file, p.project)}</span><span class="v">${fmt(f.n)}</span></li>`)}</ul>`) : ''}
        ${p.branches.length ? panel(t('Branches'), '', html`<ul class="kv">${p.branches.map((b) => html`<li><span class="k">${icon('branch')} ${b.branch}</span><span class="v">${ago(b.last)}</span></li>`)}</ul>`) : ''}
        ${p.types.length ? panel(t('Kinds of observation'), '', html`<div class="chips">${p.types.map((x) => html`<a class="chip" href="#/search?${qs({ kind: 'observations', type: x.type, project: p.project })}">${t(x.type || 'other')} <span class="num muted">${fmt(x.n)}</span></a>`)}</div>`) : ''}
      </div></div>`;
    scrollHeatToEnd();
  },
};

// --- timeline -----------------------------------------------------------------------------------------------------
const KINDS = [['obs', 'Observations'], ['sum', 'Summaries'], ['event', 'Notes & tasks']];
const eventText = (r) => `${t(r.event)}${r.to_status ? ` → ${t(r.to_status)}` : ''}${r.subtitle ? `: ${r.subtitle}` : ''}`;
const dayKey = (ms) => new Date(Number(ms)).toDateString();

function feedEntry(r, showProject) {
  const ref = refOf(r);
  const sub = r.kind === 'event' ? eventText(r) : r.subtitle;
  return html`<li class="entry" data-kind="${r.kind}">
    <div class="head"><span class="when">${timeOf(r.at)}</span>${refLink(ref)}${r.kind === 'sum' ? html`<span class="tag" data-type="summary">${t('session summary')}</span>` : typeTag(r.type)}</div>
    <a class="title" href="#" data-ref="${ref}">${clip(r.title || t('(untitled)'), 220)}</a>
    ${sub ? html`<p class="sub">${excerpt(sub, 280)}</p>` : ''}
    ${meta(metaItems({ project: showProject && r.project, device: r.device, branch: r.git_branch }))}</li>`;
}

function daySpine(rows, entry) {
  const groups = [];
  for (const r of rows) {
    const k = dayKey(r.at);
    if (groups.at(-1)?.k !== k) groups.push({ k, at: r.at, rows: [] });
    groups.at(-1).rows.push(r);
  }
  const loc = document.documentElement.lang;
  const thisYear = new Date().getFullYear();
  return html`<div class="spine">${groups.map((g) => {
    const d = new Date(g.at);
    return html`<section class="day"><div class="day-label"><b>${d.toLocaleDateString(loc, { day: 'numeric', month: 'short', ...(d.getFullYear() !== thisYear ? { year: 'numeric' } : {}) })}</b>
      <span>${d.toLocaleDateString(loc, { weekday: 'long' })}</span></div><ol class="day-items">${g.rows.map(entry)}</ol></section>`;
  })}</div>`;
}

const timelinePage = {
  async render(ctx) {
    const f = await cached('/api/facets', ctx);
    view.innerHTML = html`${head(t('Timeline'), t('Everything recorded, newest first. Filled dots are session summaries, red squares are note and task changes.'))}
      <div class="toolbar">
        <select id="t-project" aria-label="${t('Project')}">${projectOptions(f.projects, '')}</select>
        ${f.devices.length > 1 ? html`<select id="t-device" aria-label="${t('Device')}">${option('', t('All machines'), true)}${f.devices.map((d) => option(d, d))}</select>` : ''}
        <div class="seg" role="group" aria-label="${t('Show')}">${KINDS.map(([k, l]) => html`<button type="button" data-kind="${k}">${t(l)}</button>`)}</div>
        <label class="inline">${t('Up to')}<input type="date" id="t-until"></label>
      </div>
      <div id="results"></div>`;
    $('#t-project').addEventListener('change', (e) => setParams({ project: e.target.value }));
    $('#t-device')?.addEventListener('change', (e) => setParams({ device: e.target.value }));
    $('#t-until').addEventListener('change', (e) => setParams({ until: e.target.value }));
    for (const b of $$('[data-kind]', view)) {
      b.addEventListener('click', () => {
        const set = new Set((new URLSearchParams(location.hash.split('?')[1]).get('kinds') || 'obs,sum,event').split(','));
        set.has(b.dataset.kind) ? set.delete(b.dataset.kind) : set.add(b.dataset.kind);
        setParams({ kinds: set.size === 3 || !set.size ? '' : [...set].join(',') });
      });
    }
    await this.update(ctx);
  },
  async update({ params, signal }) {
    const project = params.get('project') || '';
    const kinds = params.get('kinds') || 'obs,sum,event';
    const until = params.get('until') || '';
    $('#t-project').value = project;
    if ($('#t-device')) $('#t-device').value = params.get('device') || '';
    $('#t-until').value = until;
    for (const b of $$('[data-kind]', view)) b.setAttribute('aria-pressed', String(kinds.split(',').includes(b.dataset.kind)));
    const before = until ? new Date(`${until}T00:00:00`).getTime() + DAY : undefined;
    const results = $('#results');
    results.setAttribute('aria-busy', 'true');
    const data = await api(`/api/feed?${qs({ project, kinds, device: params.get('device'), before, page: pageOf(params), size: 50 })}`, { signal });
    results.removeAttribute('aria-busy');
    results.innerHTML = (data.rows.length
      ? html`${daySpine(data.rows, (r) => feedEntry(r, !project))}${pager(data, pageHref)}`
      : html`<div class="empty"><strong>${t('Nothing recorded for this filter.')}</strong>${t('Try another project, machine or date.')}</div>`).s;
  },
};

// --- sessions -----------------------------------------------------------------------------------------------------
const sessionsPage = {
  async render(ctx) {
    const f = await cached('/api/facets', ctx);
    view.innerHTML = html`${head(t('Sessions'), t('Every Claude Code conversation, with the machine and branch it ran on.'))}
      <div class="toolbar">
        <input type="search" id="s-q" placeholder="${t('Search prompts')}" aria-label="${t('Search prompts')}">
        <select id="s-project" aria-label="${t('Project')}">${projectOptions(f.projects, '')}</select>
        ${f.devices.length > 1 ? html`<select id="s-device" aria-label="${t('Device')}">${option('', t('All machines'), true)}${f.devices.map((d) => option(d, d))}</select>` : ''}
      </div>
      <div id="results"></div>`;
    $('#s-q').addEventListener('input', debounce((e) => setParams({ q: e.target.value }, { replace: true }), 300));
    $('#s-project').addEventListener('change', (e) => setParams({ project: e.target.value }));
    $('#s-device')?.addEventListener('change', (e) => setParams({ device: e.target.value }));
    $('#s-q').value = ctx.params.get('q') || '';
    await this.update(ctx);
  },
  async update({ params, signal }) {
    const project = params.get('project') || '';
    $('#s-project').value = project;
    if ($('#s-device')) $('#s-device').value = params.get('device') || '';
    if (document.activeElement !== $('#s-q')) $('#s-q').value = params.get('q') || '';
    const data = await api(`/api/sessions?${qs({ project, device: params.get('device'), q: params.get('q'), page: pageOf(params), size: 30 })}`, { signal });
    $('#results').innerHTML = (data.rows.length
      ? html`<section class="panel"><ul class="list">${data.rows.map((x) => sessionItem(x, !project))}</ul></section>${pager(data, pageHref)}`
      : html`<div class="empty"><strong>${t('No sessions match.')}</strong>${t('Sessions appear here as soon as Claude Code runs with the plugin.')}</div>`).s;
  },
};

const sessionPage = {
  async render({ arg, signal }) {
    const s = await api(`/api/session?${qs({ id: arg })}`, { signal });
    const x = s.session;
    const obsBy = new Map();
    for (const o of s.observations) { if (!obsBy.has(o.prompt_number)) obsBy.set(o.prompt_number, []); obsBy.get(o.prompt_number).push(o); }
    const sumBy = new Map(s.summaries.map((m) => [m.prompt_number, m]));
    const known = new Set(s.prompts.map((p) => p.prompt_number));
    const loose = [...obsBy.entries()].filter(([n]) => !known.has(n)).flatMap(([, v]) => v);
    const looseSums = s.summaries.filter((m) => !known.has(m.prompt_number));
    const obsEntry = (o) => html`<li class="entry" data-kind="obs"><div class="head"><span class="when">${timeOf(o.created_at)}</span>${refLink(`${o.id}`)}${typeTag(o.type)}</div>
      <a class="title" href="#" data-ref="${o.id}">${o.title || t('(untitled)')}</a>${o.subtitle ? html`<p class="sub">${clip(o.subtitle, 240)}</p>` : ''}</li>`;
    const sumEntry = (m) => html`<li class="entry" data-kind="sum"><div class="head"><span class="when">${timeOf(m.created_at)}</span>${refLink(`S${m.id}`)}<span class="tag" data-type="summary">${t('session summary')}</span></div>
      <a class="title" href="#" data-ref="S${m.id}">${clip(m.request || t('Session summary'), 200)}</a>${m.completed ? html`<p class="sub">${excerpt(m.completed, 280)}</p>` : ''}</li>`;
    const promptEntry = (p) => {
      const text = String(p.text || '');
      return html`<li class="entry prompt-text" data-kind="prompt"><div class="head"><span class="when">${timeOf(p.created_at)}</span><span>${t('Prompt')}</span></div>
        ${text.length > 700 ? html`<p class="title clipped">${text.slice(0, 700)}…</p><details><summary class="muted">${t('Show the full prompt')}</summary><p class="title">${text}</p></details>` : html`<p class="title">${text}</p>`}</li>`;
    };
    const block = (label, time, items) => html`<section class="day"><div class="day-label"><b>${label}</b><span>${time}</span></div><ol class="day-items">${items}</ol></section>`;
    view.innerHTML = html`<nav class="crumbs"><a href="#/sessions">${icon('arrow-left')}${t('Sessions')}</a></nav>
      ${head(sessionTitle({ first_prompt: s.prompts[0]?.text, first_request: s.summaries[0]?.request }), html`${dateLong(x.started_at)}, ${timeOf(x.started_at)}`)}
      ${meta(metaItems({ project: x.project, device: x.device, branch: x.git_branch, extra: [x.cwd ? html`<span class="meta-item mono">${icon('folder')}${x.cwd}</span>` : ''] }))}
      <section class="kpis gap-top">${stat(fmt(s.prompts.length), t('prompts'))}${stat(fmt(s.observations.length), t('observations'))}
        ${stat(fmt(s.summaries.length), t('session summaries'))}${stat(x.last_at ? duration(x.last_at - x.started_at) : '-', t('duration'))}</section>
      <div class="spine gap-top">
        ${s.prompts.map((p) => block(`#${p.prompt_number}`, timeOf(p.created_at), html`${promptEntry(p)}${(obsBy.get(p.prompt_number) || []).map(obsEntry)}${sumBy.get(p.prompt_number) ? sumEntry(sumBy.get(p.prompt_number)) : ''}`))}
        ${loose.length || looseSums.length ? block(t('Other records'), '', html`${loose.map(obsEntry)}${looseSums.map(sumEntry)}`) : ''}
      </div>
      <p class="foot-note mono">${x.session_id}</p>`;
  },
};

// --- tasks --------------------------------------------------------------------------------------------------------
const COLUMNS = [['todo', 'To do'], ['doing', 'Doing'], ['blocked', 'Blocked'], ['done', 'Done']];
// An open task nobody touched for STALE_DAYS: worth closing, resuming or cancelling.
const STALE_DAYS = 14;
const isStale = (task) => OPEN.includes(task.status) && Date.now() - task.updated_at > STALE_DAYS * DAY;
const taskCard = (task, showProject) => html`<li class="card" data-p="${task.priority}" data-drag="1" data-id="${task.id}">
  <a class="title" href="#" data-ref="I${task.id}">${task.title}</a>
  <div class="meta">${isStale(task) ? html`<span class="tag" data-type="outdated" title="${t('Untouched for {n} days: close it, resume it or cancel it.', { n: STALE_DAYS })}">${t('Stale')}</span>` : ''}${refLink(`I${task.id}`)}${showProject && task.project ? html`<span>${task.project}</span>` : ''}${task.due_at ? html`<span>${t('due {day}', { day: dateShort(task.due_at) })}</span>` : ''}<span>${ago(task.updated_at)}</span></div></li>`;

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
    for (const c of $$('.drop', root)) if (c !== col) c.classList.remove('drop');
    if (col && col.closest('.board') === drag.board && col !== drag.from) col.classList.add('drop');
  };
  const begin = () => {
    drag.active = true;
    drag.li.classList.add('dragging');
    try { drag.li.setPointerCapture(drag.pointer); } catch { /* pointer already gone */ }
  };
  const end = () => {
    if (!drag) return;
    clearTimeout(drag.hold);
    drag.li.classList.remove('dragging');
    for (const c of $$('.drop', root)) c.classList.remove('drop');
    drag = null;
  };
  root.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li[data-drag]');
    if (!li || e.button !== 0 || e.target.closest('.ref')) return;
    const from = li.closest('[data-status]');
    drag = { li, from, board: from?.closest('.board'), pointer: e.pointerId, x: e.clientX, y: e.clientY, active: false, touch: e.pointerType === 'touch' };
    if (drag.touch) drag.hold = setTimeout(() => drag && begin(), 350);
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (!drag.active) {
      if (drag.touch) { if (moved > 8) end(); return; } // a swipe before the hold: let the page scroll
      if (moved < 6) return;
      begin();
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
    try {
      await api('/api/items/update', { body: { id: Number(li.dataset.id), patch: { status: col.dataset.status } } });
      toast(t('Moved to {status}', { status: t(col.dataset.status) }));
    } catch (err) { toast(err.message); }
    refresh();
  });
}

const tasksPage = {
  async render({ params, signal }) {
    const project = params.get('project') || '';
    const [{ result: tasks }, f] = await Promise.all([
      api('/api/items/list', { body: { kind: 'task', project: project || undefined, limit: 500 }, signal }),
      cached('/api/facets', { signal }),
    ]);
    const column = (st, label, rows, showProject) => html`<section class="col" data-status="${st}"><h3><span>${t(label)}</span><span class="num">${rows.length}</span></h3>
      <ol>${rows.slice(0, st === 'done' ? 30 : 200).map((x) => taskCard(x, showProject))}</ol>${st === 'done' && rows.length > 30 ? html`<p class="more-done">${t('{n} more', { n: rows.length - 30 })}</p>` : ''}</section>`;
    const inColumn = (st) => (x) => x.status === st || (st === 'done' && x.status === 'cancelled');
    let body;
    if (project) {
      body = html`<div class="board">${COLUMNS.map(([st, label]) => column(st, label, tasks.filter(inColumn(st)), false))}</div>`;
    } else {
      // Every project: one lane per project with open tasks, busiest first; done tasks of the last 7 days.
      const recent = Date.now() - 7 * DAY;
      const lanes = new Map();
      for (const x of tasks) {
        if (!OPEN.includes(x.status) && !(x.status === 'done' && (x.completed_at || x.updated_at) >= recent)) continue;
        const key = x.project || '';
        if (!lanes.has(key)) lanes.set(key, []);
        lanes.get(key).push(x);
      }
      const openCount = (rows) => rows.filter((x) => x.status !== 'done').length;
      const sorted = [...lanes.entries()].filter(([, l]) => openCount(l)).sort((a, b) => openCount(b[1]) - openCount(a[1]));
      body = sorted.length ? html`<div class="lanes">${sorted.map(([name, rows]) => html`<section class="lane">
          <header class="lane-head"><h2><a href="#/tasks?${qs({ project: name })}">${name || t('No project')}</a></h2><span class="num muted">${t('{n} open', { n: openCount(rows) })}</span></header>
          <div class="board">${COLUMNS.map(([st, label]) => column(st, st === 'done' ? 'Done (7 days)' : label, rows.filter(inColumn(st)), false))}</div></section>`)}</div>`
        : html`<div class="empty"><strong>${t('No open tasks.')}</strong>${tr('Ask Claude to track work with <code>task_add</code>, or add one above.')}</div>`;
    }
    view.innerHTML = html`${head(t('Tasks'), tr('Durable to-dos Claude and you share across sessions and machines. Drag a card to another column to change its status; Claude moves them with <code>task_update</code>.'),
      project ? html`<div class="actions"><a class="btn ghost" href="/api/export?${qs({ project })}" download>${icon('download')}${t('Export')}</a></div>` : '')}
      <form class="composer" id="new-task"><div class="row"><input type="text" name="title" placeholder="${t('New task, as an action')}" aria-label="${t('New task')}" required>
        <select name="project" aria-label="${t('Project')}">${projectOptions(f.projects, project, t('No project'))}</select>
        <select name="priority" aria-label="${t('Priority')}">${PRIORITIES.map(([v, l]) => option(v, t(l), v === 2))}</select>
        <button type="submit" class="btn primary">${icon('plus')}${t('Add task')}</button></div></form>
      <div class="toolbar"><select id="filter-project" aria-label="${t('Show project')}">${projectOptions(f.projects, project, t('All projects, by project'))}</select></div>
      ${body}`;
    enableDrag(view);
    $('#filter-project').addEventListener('change', (e) => setParams({ project: e.target.value }));
    $('#new-task').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await api('/api/items/add', { body: { kind: 'task', title: fd.get('title'), project: fd.get('project') || null, priority: Number(fd.get('priority')) } });
      toast(t('Task added'));
      refresh();
    });
  },
};

// --- notes --------------------------------------------------------------------------------------------------------
const NOTE_STATUS = [['active', 'Active'], ['archived', 'Archived'], ['all', 'All']];
const notesPage = {
  async render(ctx) {
    const f = await cached('/api/facets', ctx);
    const project = ctx.params.get('project') || '';
    view.innerHTML = html`${head(t('Notes'), tr('Decisions, conventions and gotchas worth keeping. Claude writes them with <code>note_add</code> and reads them at session start.'))}
      <details class="new"><summary class="btn primary">${icon('plus')}${t('New note')}</summary>
        <form class="composer" id="new-note"><input type="text" name="title" placeholder="${t('Note title')}" aria-label="${t('Note title')}" required>
          <textarea name="body" placeholder="${t('Details')}" aria-label="${t('Details')}"></textarea>
          <div class="row"><select name="project" aria-label="${t('Project')}">${projectOptions(f.projects, project, t('No project'))}</select><button type="submit" class="btn primary">${t('Save note')}</button></div></form></details>
      <div class="toolbar">
        <input type="search" id="n-q" placeholder="${t('Search notes')}" aria-label="${t('Search notes')}">
        <select id="n-project" aria-label="${t('Project')}">${projectOptions(f.projects, project)}</select>
        <div class="seg" role="group" aria-label="${t('Status')}">${NOTE_STATUS.map(([k, l]) => html`<button type="button" data-nstatus="${k}">${t(l)}</button>`)}</div>
      </div>
      <div id="results"></div>`;
    $('#n-q').value = ctx.params.get('q') || '';
    $('#n-q').addEventListener('input', debounce((e) => setParams({ q: e.target.value }, { replace: true }), 250));
    $('#n-project').addEventListener('change', (e) => setParams({ project: e.target.value }));
    for (const b of $$('[data-nstatus]', view)) b.addEventListener('click', () => setParams({ status: b.dataset.nstatus === 'active' ? '' : b.dataset.nstatus }));
    $('#new-note').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await api('/api/items/add', { body: { kind: 'note', title: fd.get('title'), body: fd.get('body') || null, project: fd.get('project') || null } });
      toast(t('Note saved'));
      e.target.reset();
      $('details.new').open = false;
      refresh();
    });
    await this.update(ctx);
  },
  async update({ params, signal }) {
    const status = params.get('status') || 'active';
    $('#n-project').value = params.get('project') || '';
    for (const b of $$('[data-nstatus]', view)) b.setAttribute('aria-pressed', String(b.dataset.nstatus === status));
    const q = params.get('q') || '';
    const data = await api(`/api/items?${qs({ kind: 'note', project: params.get('project'), status: status === 'all' ? '' : status, q, page: pageOf(params), size: 30 })}`, { signal });
    $('#results').innerHTML = (data.rows.length ? html`<section class="panel"><ul class="list">${data.rows.map((n) => html`<li>
        <div class="lead">${refLink(`I${n.id}`)}${n.status === 'archived' ? statusChip('archived') : ''}</div>
        <a class="title" href="#" data-ref="I${n.id}">${highlight(n.title, q)}</a><span class="aside">${ago(n.updated_at)}</span>
        ${n.body ? html`<p class="snippet">${highlight(excerpt(n.body, 260), q)}</p>` : ''}${meta(metaItems({ project: n.project }))}</li>`)}</ul></section>${pager(data, pageHref)}`
      : html`<div class="empty"><strong>${q ? t('No notes match “{query}”.', { query: q }) : t('No notes yet.')}</strong>${q ? '' : t('Write the first one with New note, or ask Claude to save a decision.')}</div>`).s;
  },
};

// --- search -------------------------------------------------------------------------------------------------------
const SEARCH_KINDS = [['all', 'Everything'], ['observations', 'Observations'], ['summaries', 'Summaries'], ['notes', 'Notes'], ['tasks', 'Tasks']];
const recentKey = 'om-recent-searches';
const readRecent = () => { try { return JSON.parse(localStorage.getItem(recentKey)) || []; } catch { return []; } };
const remember = (q) => {
  try { localStorage.setItem(recentKey, JSON.stringify([q, ...readRecent().filter((x) => x !== q)].slice(0, 8))); } catch { /* private mode */ }
};

function resultItem(r, q) {
  const ref = refOf(r);
  const tag = r.kind === 'sum' ? html`<span class="tag" data-type="summary">${t('session summary')}</span>` : typeTag(r.type);
  return html`<li><div class="lead">${refLink(ref)}${tag}${r.kind === 'item' && r.status ? statusChip(r.status) : ''}</div>
    <a class="title" href="#" data-ref="${ref}">${highlight(clip(r.title || t('(untitled)'), 200), q)}</a><span class="aside">${dateShort(r.created_at)}</span>
    ${r.snippet ? html`<p class="snippet">${highlight(excerpt(r.snippet, 300), q)}</p>` : ''}
    ${meta(metaItems({ project: r.project, device: r.device, branch: r.git_branch }))}</li>`;
}

const searchPage = {
  async render(ctx) {
    const f = await cached('/api/facets', ctx);
    view.innerHTML = html`${head(t('Search'), t('The same search Claude uses: full-text, plus meaning when the embedding model is available. Words match by prefix.'))}
      <form class="searchbar" id="sform" role="search"><div class="field">${icon('search')}<input id="q-main" type="search" name="q" autocomplete="off" spellcheck="false"
        placeholder="${t('What are you looking for?')}" aria-label="${t('Search')}"></div><button class="btn primary" type="submit">${t('Search')}</button></form>
      <div class="toolbar">
        <div class="seg" role="group" aria-label="${t('Kind')}">${SEARCH_KINDS.map(([k, l]) => html`<button type="button" data-skind="${k}">${t(l)}</button>`)}</div>
        <select id="s-project" aria-label="${t('Project')}">${projectOptions(f.projects, '')}</select>
        <select id="s-type" aria-label="${t('Type')}">${option('', t('Any type'), true)}${f.types.map((x) => option(x, t(x)))}</select>
        <label class="inline">${t('From')}<input type="date" id="s-from"></label>
        <label class="inline">${t('To')}<input type="date" id="s-to"></label>
      </div>
      <div id="results" aria-live="polite"></div>`;
    $('#q-main').value = ctx.params.get('q') || '';
    $('#sform').addEventListener('submit', (e) => { e.preventDefault(); setParams({ q: $('#q-main').value.trim() }); });
    for (const b of $$('[data-skind]', view)) b.addEventListener('click', () => setParams({ kind: b.dataset.skind === 'all' ? '' : b.dataset.skind }));
    $('#s-project').addEventListener('change', (e) => setParams({ project: e.target.value }));
    $('#s-type').addEventListener('change', (e) => setParams({ type: e.target.value }));
    $('#s-from').addEventListener('change', (e) => setParams({ from: e.target.value }));
    $('#s-to').addEventListener('change', (e) => setParams({ to: e.target.value }));
    if (!ctx.params.get('q')) $('#q-main').focus();
    await this.update(ctx);
  },
  async update({ params, signal }) {
    const q = params.get('q') || '';
    const kind = params.get('kind') || 'all';
    const filters = { project: params.get('project') || '', type: params.get('type') || '', from: params.get('from') || '', to: params.get('to') || '' };
    if (document.activeElement !== $('#q-main')) $('#q-main').value = q;
    for (const b of $$('[data-skind]', view)) b.setAttribute('aria-pressed', String(b.dataset.skind === kind));
    $('#s-project').value = filters.project;
    $('#s-type').value = filters.type;
    $('#s-type').disabled = !['all', 'observations'].includes(kind);
    $('#s-from').value = filters.from;
    $('#s-to').value = filters.to;
    const results = $('#results');
    if (!q && kind === 'all' && !Object.values(filters).some(Boolean)) {
      const recent = readRecent();
      results.innerHTML = html`<div class="tips">
        ${recent.length ? html`<section class="panel"><header class="panel-head"><h2>${t('Recent searches')}</h2></header><div class="chips">${recent.map((x) => html`<a class="chip" href="#/search?${qs({ q: x })}">${icon('clock')}${x}</a>`)}</div></section>` : ''}
        <p>${t('Search a file name, an error message, a decision or a command. Filters on their own list the latest matching records.')}</p></div>`.s;
      return;
    }
    if (q) remember(q);
    results.setAttribute('aria-busy', 'true');
    const data = await api(`/api/find?${qs({ q, kind, ...filters, type: $('#s-type').disabled ? '' : filters.type, page: pageOf(params), size: 25 })}`, { signal });
    results.removeAttribute('aria-busy');
    results.innerHTML = (data.rows.length
      ? html`<p class="result-sum">${q ? (data.total === 1 ? t('1 result for “{query}”', { query: q }) : t('{n} results for “{query}”', { n: fmt(data.total), query: q })) : t('{n} records', { n: fmt(data.total) })}</p>
        <section class="panel"><ul class="list">${data.rows.map((r) => resultItem(r, q))}</ul></section>${pager(data, pageHref)}`
      : html`<div class="empty"><strong>${q ? t('No matches for “{query}”.', { query: q }) : t('Nothing matches these filters.')}</strong>${t('Try fewer words, another kind or a wider date range.')}</div>`).s;
  },
};

// --- local LLM ----------------------------------------------------------------------------------------------------
const RANGES = [[24, '24 hours'], [168, '7 days'], [720, '30 days']];
const TASK_LABELS = { observation: 'Tool calls', summary: 'Turn summaries', brief: 'Project briefs', review: 'Notes reviews', lessons: 'Repeated mistakes', embed: 'Embeddings', other: 'Other' };
const gb = (bytes) => `${(Number(bytes || 0) / 1e9).toLocaleString(document.documentElement.lang, { maximumFractionDigits: 1 })} GB`;
const num1 = (n) => Number(n).toLocaleString(document.documentElement.lang, { maximumFractionDigits: 1 });
const ms = (n) => (n == null ? '-' : n < 1000 ? `${Math.round(n)} ms` : `${num1(n / 1000)} s`);
const until = (left) => (left < 90000
  ? new Intl.RelativeTimeFormat(document.documentElement.lang, { numeric: 'auto', style: 'short' }).format(Math.max(0, Math.round(left / 1000)), 'second')
  : ago(Date.now() + left));
const level = (ratio) => (ratio >= 0.95 ? 'danger' : ratio >= 0.85 ? 'warn' : '');
// `warn`: the fill turns amber, then red, near full (memory in use); off where full is good (share on the GPU).
const meter = (ratio, label, warn = true) => html`<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ratio * 100)}" aria-label="${label}"
  ${warn && level(ratio) ? raw(`data-level="${level(ratio)}"`) : ''}><span style="width:${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%"></span></div>`;

// Round ticks for an axis from 0 to at least `max`.
function niceTicks(max, count = 3) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) * mag;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

function bucketLabel(at, hours) {
  const d = new Date(at);
  const loc = document.documentElement.lang;
  return hours <= 24 ? timeOf(at) : d.toLocaleDateString(loc, hours <= 168 ? { weekday: 'short', day: 'numeric' } : { day: 'numeric', month: 'short' });
}

// Columns over time. `stack(b)` returns the segments of one column from the baseline up: [{ v, cls }].
function columnChart({ title, legend = '', buckets, hours, stack, tip, fmtTick = fmt, empty }) {
  const totals = buckets.map((b) => stack(b).reduce((n, s) => n + (s.v || 0), 0));
  const ticks = niceTicks(Math.max(0, ...totals));
  const top = ticks.at(-1);
  const every = Math.ceil(buckets.length / 6);
  const n = buckets.length;
  return html`<figure class="chart"><div class="chart-head"><h3>${title}</h3>${legend}</div>
    <div class="chart-plot">
      <div class="chart-grid" aria-hidden="true">${ticks.map((v) => html`<span style="bottom:${(v / top) * 100}%"><i>${fmtTick(v)}</i></span>`)}</div>
      <div class="chart-cols" style="--n:${n}">${buckets.map((b) => html`<div tabindex="0" data-tip="${tip(b)}">${stack(b).filter((s) => s.v > 0)
        .map((s) => html`<i class="${s.cls}" style="height:max(2px, calc(${(s.v / top) * 100}% - 2px))"></i>`)}</div>`)}</div>
      ${totals.some((v) => v > 0) ? '' : html`<p class="chart-empty">${empty}</p>`}
    </div>
    <div class="chart-x" aria-hidden="true">${buckets.map((b, i) => (i % every === 0 ? html`<span style="left:${((i + 0.5) / n) * 100}%">${bucketLabel(b.at, hours)}</span>` : ''))}</div></figure>`;
}

// One floating tooltip for every chart column (pointer and keyboard).
const tipEl = Object.assign(document.createElement('div'), { className: 'chart-tip', hidden: true });
document.body.append(tipEl);
function placeTip(x, y) {
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  tipEl.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, x + 14))}px`;
  tipEl.style.top = `${y - h - 12 < 8 ? y + 18 : y - h - 12}px`;
}
document.addEventListener('pointermove', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) { tipEl.hidden = true; return; }
  tipEl.textContent = el.dataset.tip;
  tipEl.hidden = false;
  placeTip(e.clientX, e.clientY);
});
document.addEventListener('focusin', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) { tipEl.hidden = true; return; }
  const r = el.getBoundingClientRect();
  tipEl.textContent = el.dataset.tip;
  tipEl.hidden = false;
  placeTip(r.left + r.width / 2, r.top);
});
document.addEventListener('scroll', () => { tipEl.hidden = true; }, { passive: true });

function llmState(s) {
  const waiting = s.queue.counts.filter((c) => c.status !== 'failed').reduce((n, c) => n + c.n, 0);
  if (s.waitingForLlm) return ['down', t('Not answering'), t('{n} items wait for it', { n: fmt(waiting) })];
  if (s.pause) return ['paused', t('Paused'), pauseText(s.pause)];
  if (s.provider.kind === 'none') return ['off', t('No LLM'), s.provider.reason ? clip(s.provider.reason, 90) : ''];
  if (s.drainer) return ['work', t('Working'), t('processing the queue')];
  return ['ready', t('Ready'), waiting ? t('{n} items waiting', { n: fmt(waiting) }) : t('queue empty')];
}

const llmPage = {
  timer: null,
  hours: 24,
  async render(ctx) {
    view.innerHTML = html`${head(t('Local LLM'), t('The model that turns tool calls into memory: what it is doing, how fast, and what is waiting. Nothing here uses your Claude plan.'),
      html`<div class="btns"><p class="updated" id="llm-updated"></p>${refreshButton()}</div>`)}<div id="llm">${skeleton(8)}</div>`;
    view.onclick = (e) => this.act(e);
    view.onchange = (e) => { if (e.target.id === 'pin-model') this.post('model', { model: e.target.value }); };
    clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), 5000);
    await this.update(ctx);
  },
  async update({ params, signal }) {
    this.hours = Number(params.get('hours')) || 24;
    await this.load(signal);
  },
  leave() { clearInterval(this.timer); this.timer = null; view.onclick = null; view.onchange = null; },
  // Live while the tab is visible; skipped while a menu of the page is in use or the record panel is open.
  poll() {
    if (!$('#llm')) { this.leave(); return; }
    if ($('#app').hidden || document.visibilityState !== 'visible' || drawer.open || document.activeElement?.closest?.('#llm select')) return;
    this.load().catch(() => {});
  },
  async load(signal) {
    const s = await api(`/api/engine?${qs({ hours: this.hours })}`, { signal });
    const open = new Set($$('#llm details[open]').map((d) => d.dataset.key));
    $('#llm').innerHTML = this.draw(s).s;
    for (const d of $$('#llm details[data-key]')) if (open.has(d.dataset.key)) d.open = true;
    $('#llm-updated').textContent = t('Updated {time}', { time: new Date(s.now).toLocaleTimeString(document.documentElement.lang) });
  },
  async post(action, body = {}) {
    try {
      const { result } = await api(`/api/engine/${action}`, { body });
      const msg = {
        drain: () => (result.started ? t('Processing the queue') : t('Already processing')),
        retry: () => t('{n} items queued again', { n: result.retried }),
        unload: () => (result.unloaded.length ? t('Freed {models}', { models: result.unloaded.join(', ') }) : t('Nothing was loaded')),
        load: () => t('{model} loaded in {time}', { model: result.loaded, time: ms(result.ms) }),
        model: () => (result.model ? t('Chat model: {model}', { model: result.model }) : t('Chat model: automatic')),
        embed: () => t('Embedding every record in the background'),
      }[action];
      toast(msg());
    } catch (err) { toast(err.message); }
    this.load().catch(() => {});
  },
  async act(e) {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      btn.disabled = true;
      await this.post(btn.dataset.action, btn.dataset.force ? { force: true } : {});
      return;
    }
    const range = e.target.closest('[data-hours]');
    if (range) setParams({ hours: range.dataset.hours === '24' ? '' : range.dataset.hours });
  },
  draw(s) {
    const [state, stateLabel, stateSub] = llmState(s);
    const st = s.stats;
    const o = s.ollama;
    const count = (kind, status) => s.queue.counts.filter((c) => (!kind || c.kind === kind) && c.status === status).reduce((n, c) => n + c.n, 0);
    const waiting = count(null, 'pending') + count(null, 'processing');
    const failed = count(null, 'failed');
    const oldest = Math.min(...s.queue.counts.filter((c) => c.status !== 'failed').map((c) => c.oldest));
    const rangeName = t(RANGES.find(([h]) => h === st.hours)?.[1] || '24 hours');
    const local = s.provider.setting === 'auto' || s.provider.setting === 'ollama';
    const chatModels = o?.up ? o.installed.filter((m) => m.chat) : [];

    const status = html`<section class="kpis" aria-label="${t('Summary')}">
      <div class="kpi"><span class="state" data-s="${state}">${stateLabel}</span><small>${stateSub}</small></div>
      ${stat(st.chat.speed ? html`${num1(st.chat.speed)} <small>tok/s</small>` : '-', t('generation speed, {range}', { range: rangeName }))}
      ${stat(ms(st.chat.p50), st.chat.p95 ? t('median call, p95 {time}', { time: ms(st.chat.p95) }) : t('median call'))}
      ${stat(fmt(st.chat.calls), st.chat.failed ? t('calls, {n} failed', { n: fmt(st.chat.failed) }) : t('calls, {range}', { range: rangeName }))}
      ${stat(fmt(waiting), waiting ? t('in the queue, oldest {when}', { when: ago(oldest) }) : t('in the queue'))}
    </section>`;

    const loaded = !local ? emptyPanel(t('Provider {provider} at {url}: memory and GPU are not visible from here.', { provider: s.provider.kind, url: s.provider.endpoint || '-' }))
      : !o?.up ? html`<div class="empty"><strong>${t('Ollama is not answering at {url}.', { url: o?.url || '' })}</strong>${t('Start Ollama; queued items wait for it.')}</div>`
        : html`${o.loaded.length ? o.loaded.map((m) => html`<div class="res"><div class="res-head"><b>${m.name}</b><span>${[m.params, m.quant].filter(Boolean).join(' ')}</span></div>
            ${meter(m.size ? (m.vram || 0) / m.size : 0, t('Share on the GPU'), false)}
            <div class="minis"><span>${t('Uses')} <b>${gb(m.size)}</b></span><span><b>${m.size ? Math.round(((m.vram || 0) / m.size) * 100) : 0}%</b> ${t('on the GPU')}</span>
              ${m.context ? html`<span>${t('context')} <b>${fmt(m.context)}</b></span>` : ''}
              <span>${s.drainer || (m.expiresAt && m.expiresAt - s.now < 2000) ? html`<b>${t('in use now')}</b>`
                : m.expiresAt && m.expiresAt - s.now < 365 * 864e5 ? html`${t('frees memory')} <b>${until(m.expiresAt - s.now)}</b>` : t('stays loaded')}</span></div></div>`)
          : emptyPanel(t('No model in memory. Ollama loads {model} on the next call and frees it {keep} after the last one.', { model: s.provider.model || '-', keep: s.provider.keepAlive || '5m' }))}
          <div class="btns">${s.provider.model ? html`<button class="btn" type="button" data-action="load">${t('Load {model}', { model: s.provider.model })}</button>` : ''}
            ${o.loaded.length ? html`<button class="btn ghost" type="button" data-action="unload">${t('Free the memory')}</button>` : ''}</div>`;

    const gpuCard = (g, from = '') => {
      const ratio = g.memTotalMb ? g.memUsedMb / g.memTotalMb : 0;
      return html`<div class="res"><div class="res-head"><b>${g.name}</b><span>${num1(g.memUsedMb / 1024)} / ${num1(g.memTotalMb / 1024)} GB</span></div>
        ${meter(ratio, t('Video memory in use'))}
        <div class="minis">${from ? html`<span>${from}</span>` : ''}${g.util != null ? html`<span>${t('load')} <b>${g.util}%</b></span>` : ''}${g.temp != null ? html`<span>${t('temperature')} <b>${g.temp} °C</b></span>` : ''}
          ${g.powerW != null ? html`<span>${t('power')} <b>${Math.round(g.powerW)} W</b></span>` : ''}</div></div>`;
    };
    // No NVIDIA GPU here but a machine that runs Ollama reported its own: show that one and say where it is.
    const remote = s.gpus?.length ? [] : (s.remoteGpus || []);
    const gpus = s.gpus?.length ? s.gpus.map((g) => gpuCard(g))
      : remote.length ? html`${remote.map((r) => r.gpus.map((g) => gpuCard(g, html`${t('on')} <b>${r.device}</b>, ${ago(r.at)}`)))}
        <p class="muted">${t('The GPU is on another machine ({devices}): this server has no NVIDIA GPU of its own, so the page shows what that machine sent after its last queue run.', { devices: remote.map((r) => r.device).join(', ') })}</p>`
      : emptyPanel(s.gpuError === 'missing' ? t('nvidia-smi was not found. It comes with the NVIDIA driver: install or update the driver, or add nvidia-smi to PATH.')
        : s.gpuError ? t('nvidia-smi failed: {error}', { error: s.gpuError }) : t('No NVIDIA GPU found.'));

    const legend = html`<div class="legend"><span><i class="sw-1"></i>${t('Done')}</span><span><i class="sw-crit"></i>${t('Failed')}</span></div>`;
    const span = (b) => `${bucketLabel(b.at, st.hours)}${st.hours <= 24 ? ` - ${timeOf(b.at + st.bucketMs)}` : ''}`;
    const charts = html`<div class="charts">
      ${columnChart({ title: t('Generation speed (tokens per second)'), buckets: st.buckets, hours: st.hours, fmtTick: (v) => fmt(v),
        stack: (b) => [{ v: b.speed || 0, cls: 'sw-1' }], empty: t('No calls in this period.'),
        tip: (b) => (b.calls ? `${span(b)}\n${num1(b.speed || 0)} tok/s, ${t('{n} calls', { n: b.calls })}, ${t('average {time}', { time: ms(b.avgMs) })}` : `${span(b)}\n${t('No calls')}`) })}
      ${columnChart({ title: t('Calls'), legend, buckets: st.buckets, hours: st.hours, empty: t('No calls in this period.'),
        stack: (b) => [{ v: b.calls - b.failed, cls: 'sw-1' }, { v: b.failed, cls: 'sw-crit' }],
        tip: (b) => `${span(b)}\n${t('{n} calls', { n: b.calls })}${b.failed ? `, ${t('{n} failed', { n: b.failed })}` : ''}` })}
    </div>
    <details class="as-table" data-key="tasks"><summary>${t('By task')}</summary><div class="scroll-x"><table class="data">
      <thead><tr><th>${t('Task')}</th><th class="n">${t('Calls')}</th><th class="n">${t('Failed')}</th><th class="n">${t('Tokens in')}</th><th class="n">${t('Tokens out')}</th><th class="n">tok/s</th><th class="n">${t('Average')}</th></tr></thead>
      <tbody>${st.tasks.length ? st.tasks.map((r) => html`<tr><td>${t(TASK_LABELS[r.task] || r.task)}</td><td class="n">${fmt(r.calls)}</td><td class="n">${fmt(r.calls - r.ok)}</td>
        <td class="n">${fmt(r.prompt_tokens)}</td><td class="n">${r.task === 'embed' ? '-' : fmt(r.output_tokens)}</td><td class="n">${r.speed ? num1(r.speed) : '-'}</td><td class="n">${ms(r.total_ms / r.calls)}</td></tr>`)
        : html`<tr><td colspan="7" class="muted">${t('No calls in this period.')}</td></tr>`}</tbody></table></div></details>
    <details class="as-table" data-key="buckets"><summary>${t('Show the charts as a table')}</summary><div class="scroll-x"><table class="data">
      <thead><tr><th>${t('Period')}</th><th class="n">${t('Calls')}</th><th class="n">${t('Failed')}</th><th class="n">tok/s</th><th class="n">${t('Average')}</th></tr></thead>
      <tbody>${st.buckets.filter((b) => b.calls).reverse().map((b) => html`<tr><td>${span(b)}</td><td class="n">${fmt(b.calls)}</td><td class="n">${fmt(b.failed)}</td><td class="n">${b.speed ? num1(b.speed) : '-'}</td><td class="n">${ms(b.avgMs)}</td></tr>`)}</tbody></table></div></details>`;

    const queueRow = (q) => html`<li><div class="lead"><span class="tag">${q.kind === 'summary' ? t('Turn summary') : q.tool || t('Tool calls')}</span>${q.status === 'processing' ? statusChip('doing') : ''}
      <span>${ago(q.created_at)}</span>${q.attempts ? html`<span>${t('attempt {n}', { n: q.attempts })}</span>` : ''}</div>
      <span class="title mono">${q.kind === 'summary' ? t('Prompt #{n}', { n: q.prompt_number ?? '?' }) : clip(q.what || q.tool || '-', 140)}</span>
      ${meta(metaItems({ project: q.project }))}${q.error ? html`<p class="snippet err">${clip(q.error, 220)}</p>` : ''}</li>`;
    const queue = html`<div class="minis"><span>${t('Tool calls')} <b>${fmt(count('observation', 'pending') + count('observation', 'processing'))}</b></span>
        <span>${t('Turn summaries')} <b>${fmt(count('summary', 'pending') + count('summary', 'processing'))}</b></span><span>${t('Failed')} <b>${fmt(failed)}</b></span></div>
      <div class="btns"><button class="btn primary" type="button" data-action="drain" ${s.drainer ? raw('disabled') : ''}>${s.drainer ? t('Processing…') : t('Process the queue now')}</button>
        ${s.provider.kind === 'ollama' && (s.provider.pauseWhenBusy || s.pause?.kind === 'manual') ? html`<button class="btn" type="button" data-action="drain" data-force="1" ${s.drainer ? raw('disabled') : ''}>${t('Process now, even during a game or a pause')}</button>` : ''}
        ${failed ? html`<button class="btn" type="button" data-action="retry">${t('Retry {n} failed', { n: fmt(failed) })}</button>` : ''}</div>
      ${s.queue.next.length ? html`<h3 class="sub-h">${t('Next in line')}</h3><ul class="list compact">${s.queue.next.map(queueRow)}</ul>` : html`<p class="foot-note">${t('Nothing waiting: every tool call is already in memory.')}</p>`}
      ${s.queue.failed.length ? html`<details class="as-table" data-key="failed"><summary>${t('Failed items ({n})', { n: fmt(failed) })}</summary><ul class="list compact">${s.queue.failed.map(queueRow)}</ul></details>` : ''}`;

    const models = !local ? emptyPanel(t('Models are chosen in the provider settings.'))
      : !o?.up ? emptyPanel(t('Ollama is not answering.'))
        : html`<label class="field-label" for="pin-model">${t('Chat model')}</label>
          <select id="pin-model">${option('', t('Automatic ({model})', { model: s.provider.pinned ? '-' : s.provider.model || '-' }), !s.provider.pinned)}${chatModels.map((m) => option(m.name, m.name, m.name === s.provider.pinned))}</select>
          ${o.installed.length ? html`<ul class="kv gap-top">${o.installed.map((m) => html`<li><span class="k">${m.name}
            ${m.name === s.provider.model ? html` <span class="tag" data-type="summary">${t('in use')}</span>` : ''}${m.name.split(':')[0] === String(s.embeddings.model).split(':')[0] ? html` <span class="tag" data-type="note">${t('search')}</span>` : ''}</span>
            <span class="v">${[m.params, m.quant, gb(m.size)].filter(Boolean).join(' · ')}</span></li>`)}</ul>`
            : emptyPanel(tr('No models installed. Run <code>ollama pull gemma3:12b</code> (or gemma3:4b on a small GPU) and <code>ollama pull embeddinggemma</code>.'))}
          <p class="foot-note">${t('Ollama {version} at {url}.', { version: o.version || '?', url: o.url })}</p>`;

    const e = s.embeddings;
    const total = e.enabled ? e.done + e.pending : 0;
    const index = !e.enabled ? emptyPanel(t('Semantic search is off: search is full-text only.'))
      : html`${meter(total ? e.done / total : 0, t('Records searchable by meaning'), false)}
        <p class="foot-note">${t('{done} of {total} records searchable by meaning ({model}).', { done: fmt(e.done), total: fmt(total), model: e.model })}</p>
        ${e.pending ? html`<div class="btns"><button class="btn" type="button" data-action="embed">${t('Index everything now')}</button></div>` : ''}`;

    const recent = st.recent.length ? html`<div class="scroll-x"><table class="data">
      <thead><tr><th>${t('When')}</th><th>${t('Task')}</th><th>${t('Model')}</th><th class="n">${t('Tokens in')}</th><th class="n">${t('Tokens out')}</th><th class="n">tok/s</th><th class="n">${t('Load')}</th><th class="n">${t('Total')}</th><th>${t('Result')}</th></tr></thead>
      <tbody>${st.recent.map((c) => html`<tr><td>${timeOf(c.at)} <span class="muted">${ago(c.at)}</span></td><td>${t(TASK_LABELS[c.task] || c.task)}${c.items ? ` (${c.items})` : ''}</td><td>${c.model || '-'}</td>
        <td class="n">${c.prompt_tokens != null ? fmt(c.prompt_tokens) : '-'}</td><td class="n">${c.output_tokens != null && c.task !== 'embed' ? fmt(c.output_tokens) : '-'}</td>
        <td class="n">${c.output_tokens && c.eval_ms ? num1(c.output_tokens / (c.eval_ms / 1000)) : '-'}</td><td class="n">${c.load_ms > 50 ? ms(c.load_ms) : '-'}</td><td class="n">${ms(c.total_ms)}</td>
        <td>${c.ok ? statusChip('done') : html`<span class="err" title="${c.error || ''}">${clip(c.error || t('Failed'), 60)}</span>`}</td></tr>`)}</tbody></table></div>`
      : emptyPanel(t('No calls recorded yet. They appear here as soon as the queue is processed with an LLM.'));

    const panel = (title, aside, body) => html`<section class="panel"><header class="panel-head"><h2>${title}</h2>${aside || ''}</header>${body}</section>`;
    return html`${status}
      ${queuesPanel(s.clients, t('Queues on other machines'), t('Each machine processes its own queue and reports it here every 30 seconds while it works.'), refreshButton())}
      <div class="cols">${panel(t('In memory'), o?.up ? html`<span class="muted">${t('{n} loaded', { n: o.loaded.length })}</span>` : '', loaded)}${panel(t('GPU'), '', gpus)}</div>
      ${panel(t('Speed and calls'), html`<div class="seg" role="group" aria-label="${t('Period')}">${RANGES.map(([h, l]) => html`<button type="button" data-hours="${h}" aria-pressed="${h === st.hours}">${t(l)}</button>`)}</div>`, charts)}
      <div class="cols">${panel(t('Queue'), s.drainer ? html`<span class="state" data-s="work">${t('Working')}</span>` : '', queue)}<div class="stack">${panel(t('Models'), '', models)}${panel(t('Semantic search index'), '', index)}</div></div>
      ${panel(t('Latest calls'), '', recent)}`;
  },
};

// --- router ---------------------------------------------------------------------------------------------------------
const ROUTES = {
  overview: overviewPage, projects: projectsPage, project: projectPage, timeline: timelinePage, sessions: sessionsPage, session: sessionPage,
  tasks: tasksPage, notes: notesPage, search: searchPage, llm: llmPage,
};
const TITLES = { overview: 'Progress', projects: 'Projects', project: 'Projects', timeline: 'Timeline', tasks: 'Tasks', notes: 'Notes', search: 'Search', sessions: 'Sessions', session: 'Sessions', llm: 'Local LLM' };
const NAV = { project: 'projects', session: 'sessions' };
let current = null;
let controller = null;

async function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const [first = 'overview', ...rest] = path.split('/');
  const name = ROUTES[first] ? first : 'overview';
  const arg = rest.length ? decodeURIComponent(rest.join('/')) : undefined;
  closeDrawer();
  setMenu(false);
  for (const a of $$('[data-nav]')) {
    if (a.dataset.nav === (NAV[name] || name)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.body.dataset.route = name;
  document.title = `${t(TITLES[name])} · open-mem`;
  controller?.abort();
  controller = new AbortController();
  const ctx = { params, arg, signal: controller.signal };
  const page = ROUTES[name];
  const update = current && current.name === name && current.arg === arg && page.update;
  const scroll = !update || current.page !== params.get('page');
  const busy = setTimeout(() => document.body.classList.add('busy'), 150);
  try {
    if (update) await page.update(ctx);
    else {
      if (current && current.name !== name) ROUTES[current.name].leave?.();
      view.innerHTML = skeleton(10).s;
      await page.render(ctx);
      view.focus({ preventScroll: true });
    }
    current = { name, arg, page: params.get('page') };
    if (scroll) window.scrollTo({ top: 0 });
  } catch (err) {
    if (err.name === 'AbortError' || err.message === LOGIN_REQUIRED) return;
    current = null;
    view.innerHTML = html`<p class="error-box">${t('Could not load this page: {error}', { error: err.message })}</p>`.s;
  } finally {
    clearTimeout(busy);
    if (ctx.signal === controller.signal) document.body.classList.remove('busy');
  }
}
// Re-render the current page after a write (data changed under it).
function refresh() { current = null; route(); }
// Reload the page's data by hand, besides its own refresh.
const refreshButton = () => html`<button class="btn" type="button" data-refresh>${t('Refresh')}</button>`;
document.addEventListener('click', (e) => { if (e.target.closest('[data-refresh]')) refresh(); });

async function start() {
  const me = await api('/api/me');
  if (!me.authenticated) return showLogin();
  $('#login').hidden = true;
  $('#app').hidden = false;
  api('/api/meta').then((m) => { $('#version').textContent = `open-mem ${m.version}`; }).catch(() => {});
  current = null;
  route();
}
window.addEventListener('hashchange', route);
start();

// open-mem web viewer. No framework: hash routes, one fetch helper, escaped templates.
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');

// --- escaped templates ----------------------------------------------------------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(String(s));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flat = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(flat).join('') : v === false || v == null ? '' : esc(v));
const html = (strings, ...vals) => raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? flat(vals[i]) : ''), ''));

// --- api -------------------------------------------------------------------------------
async function api(path, body) {
  const res = await fetch(path, body === undefined ? { credentials: 'same-origin' } : {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('login required'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const q = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();

// --- formatting -----------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => { const d = new Date(Number(ms)); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const timeOf = (ms) => { const d = new Date(Number(ms)); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const weekday = (ms) => new Date(Number(ms)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
function ago(ms) {
  if (!ms) return 'never';
  const s = (Date.now() - Number(ms)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return dayOf(ms);
}
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const list = (v) => { if (!v) return []; try { const a = JSON.parse(v); return Array.isArray(a) ? a : [String(v)]; } catch { return [String(v)]; } };
const refOf = (r) => (r.kind === 'sum' ? `S${r.id}` : r.kind === 'item' || r.kind === 'event' ? `I${r.id}` : `${r.id}`);
const refLink = (ref) => html`<a class="ref" href="#" data-ref="${ref}">${ref}</a>`;
const typeTag = (t) => (t ? html`<span class="tag type-${t}">${t}</span>` : '');
const fmt = (n) => Number(n || 0).toLocaleString();

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
  return html`<dl>${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}
const section = (label, body) => (body ? html`<h3>${label}</h3>${body}` : '');
const bullets = (v) => { const a = list(v); return a.length ? html`<ul>${a.map((x) => html`<li>${x}</li>`)}</ul>` : ''; };

async function openRecord(ref) {
  drawer.hidden = false;
  $('#drawer-body').innerHTML = '<p class="muted">Loading…</p>';
  let r;
  try { r = await api(`/api/record?${q({ ref })}`); } catch (err) { $('#drawer-body').textContent = err.message; return; }
  let body;
  if (r.kind === 'sum') {
    body = html`<p class="ref">S${r.id} · session summary</p><h2>${r.request || 'Session summary'}</h2>
      ${[['Investigated', r.investigated], ['Learned', r.learned], ['Completed', r.completed], ['Next steps', r.next_steps], ['Notes', r.notes]]
        .map(([k, v]) => section(k, v && html`<div class="prose">${v}</div>`))}
      ${section('Files modified', bullets(r.files_modified))}${metaList(r)}`;
  } else if (r.kind === 'item') {
    body = html`<p class="ref">I${r.id} · ${r.item_kind} · ${r.status}</p>${itemEditor(r)}${metaList(r)}
      ${section('History', html`<ul>${(r.events || []).map((e) => html`<li><span class="num">${dayOf(e.at)} ${timeOf(e.at)}</span> · ${e.event}${e.to_status ? ` → ${e.to_status}` : ''}${e.detail ? `: ${e.detail}` : ''}${e.device ? html` <span class="muted">(${e.device})</span>` : ''}</li>`)}</ul>`)}`;
  } else {
    body = html`<p class="ref">${r.id} · observation ${typeTag(r.type)}</p><h2>${r.title || '(untitled)'}</h2>
      ${r.subtitle ? html`<p class="muted">${r.subtitle}</p>` : ''}${r.narrative ? html`<div class="prose">${r.narrative}</div>` : ''}
      ${section('Facts', bullets(r.facts))}${section('Concepts', list(r.concepts).length ? html`<p>${list(r.concepts).map((c) => html`<span class="tag">${c}</span> `)}</p>` : '')}
      ${section('Files modified', bullets(r.files_modified))}${section('Files read', bullets(r.files_read))}${metaList(r)}
      <p><button class="secondary" data-around="${r.id}">What happened around this</button></p>`;
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
    <input type="text" name="title" value="${r.title}" aria-label="Title" required>
    <textarea name="body" aria-label="Details">${r.body || ''}</textarea>
    <div class="line">
      <select name="status" aria-label="Status">${statuses.map((s) => html`<option ${s === r.status ? raw('selected') : ''}>${s}</option>`)}</select>
      ${isTask ? html`<select name="priority" aria-label="Priority">${[[1, 'High'], [2, 'Normal'], [3, 'Low']].map(([v, l]) => html`<option value="${v}" ${v === r.priority ? raw('selected') : ''}>${l}</option>`)}</select>
        <input type="date" name="due" aria-label="Due date" value="${r.due_at ? dayOf(r.due_at) : ''}">` : ''}
    </div>
    <input type="text" name="comment" placeholder="Progress comment (optional)" aria-label="Comment">
    <div class="line"><button type="submit">Save changes</button><button type="button" class="secondary" id="item-delete">Delete</button></div>
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
    if (e.target.dataset.confirm !== '1') { e.target.dataset.confirm = '1'; e.target.textContent = 'Click again to delete for good'; return; }
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
    cells.push(html`<i data-l="${l}" title="${key}: ${n} records"></i>`);
  }
  return html`<div class="strip" role="img" aria-label="Records per day, last ${days} days">${cells}</div>`;
}

function taskRow(t) {
  return html`<li><span>${refLink(`I${t.id}`)}</span><span class="title" data-ref="I${t.id}">${t.title}</span>
    <span class="side"><span class="status ${t.status}">${t.status}</span>${t.due_at ? ` · due ${dayOf(t.due_at)}` : ''}</span>
    <span class="sub">${t.project || 'no project'}${t.directory ? ` · ${t.directory}` : ''}</span></li>`;
}

async function overviewView() {
  const o = await api('/api/overview');
  const s = o.stats;
  const tasksBy = Object.fromEntries(o.tasks.map((t) => [t.status, t.n]));
  view.innerHTML = html`<h1 class="page">Progress</h1>
    <p class="lede">Everything Claude has remembered across your machines, and the work still open.</p>
    <div class="figures">
      <div class="figure"><b>${fmt(tasksBy.doing)}</b><span>tasks in progress</span></div>
      <div class="figure"><b>${fmt((tasksBy.todo || 0) + (tasksBy.blocked || 0))}</b><span>tasks waiting</span></div>
      <div class="figure"><b>${fmt(o.doneWeek)}</b><span>tasks done this week</span></div>
      <div class="figure"><b>${fmt(s.observations)}</b><span>observations</span></div>
      <div class="figure"><b>${fmt(s.summaries)}</b><span>session summaries</span></div>
      <div class="figure"><b>${fmt(s.notes)}</b><span>notes</span></div>
    </div>
    <h2>Activity</h2>${activityStrip(o.activity)}
    <div class="two">
      <div><h2>Open tasks</h2>${o.openTasks.length ? html`<ul class="rows">${o.openTasks.map(taskRow)}</ul>` : html`<p class="empty">No open tasks. Ask Claude to track work with <code>task_add</code>, or add one under Tasks.</p>`}
        <h2>Latest sessions</h2><ul class="rows">${o.recentSessions.map((x) => html`<li><span class="ref num">${timeOf(x.started_at)}</span>
          <a class="title" href="#/session/${encodeURIComponent(x.session_id)}">${clip(x.first_request || x.first_prompt || '(no prompt)', 110)}</a>
          <span class="side">${ago(x.started_at)}</span><span class="sub">${x.project}${x.device ? ` · ${x.device}` : ''} · ${x.prompt_counter} prompts · ${x.obs} observations</span></li>`)}</ul></div>
      <div><h2>Active projects</h2><ul class="files">${o.projects.map((p) => html`<li><a href="#/project/${encodeURIComponent(p.project)}">${p.project}</a><span class="muted">${ago(p.last)}</span></li>`)}</ul>
        ${o.devices.length ? html`<h2>Machines</h2><ul class="files">${o.devices.map((d) => html`<li><span>${d.device}</span><span class="muted num">${fmt(d.n)} · ${ago(d.last)}</span></li>`)}</ul>` : ''}
        ${s.unsynced ? html`<p class="muted">${fmt(s.unsynced)} records not yet pushed to the shared server.</p>` : ''}</div>
    </div>`;
}

async function projectsView() {
  const rows = await api('/api/projects');
  view.innerHTML = html`<h1 class="page">Projects</h1><p class="lede">One card per working folder. Open one for its brief, tasks, notes and history.</p>
    <input type="search" id="pfilter" placeholder="Filter projects" aria-label="Filter projects" style="max-width:320px;margin-bottom:16px">
    <div class="grid" id="pgrid">${rows.map((p) => {
      const total = p.openTasks + p.doneTasks;
      return html`<article class="card" data-name="${p.project.toLowerCase()}"><a class="cover" href="#/project/${encodeURIComponent(p.project)}" aria-label="${p.project}"></a>
        <h3>${p.project}</h3><div class="meta"><span>${fmt(p.obs)} observations</span><span>${fmt(p.sums)} sessions</span><span>last ${ago(p.last)}</span></div>
        <div class="meta"><span>${p.openTasks} open · ${p.doneTasks} done</span><span>${p.notes} notes</span></div>
        ${total ? html`<div class="bar" title="${p.doneTasks} of ${total} tasks done"><span style="width:${Math.round((p.doneTasks / total) * 100)}%"></span></div>` : ''}</article>`;
    })}</div>`;
  $('#pfilter').addEventListener('input', (e) => {
    const v = e.target.value.toLowerCase();
    for (const c of view.querySelectorAll('.card')) c.hidden = !c.dataset.name.includes(v);
  });
}

async function projectView(name) {
  const p = await api(`/api/project?${q({ name })}`);
  const open = p.tasks.filter((t) => ['todo', 'doing', 'blocked'].includes(t.status));
  view.innerHTML = html`<p><a href="#/projects" class="muted">Projects</a></p><h1 class="page">${p.project}</h1>
    <p class="lede">${fmt(p.obs)} observations · ${fmt(p.sums)} sessions · since ${dayOf(p.first)} · last ${ago(p.last)}</p>
    ${activityStrip(p.activity, 364)}
    <div class="two"><div>
      <h2>Brief</h2>${p.brief ? html`<div class="brief">${p.brief.body}</div><p class="muted">Generated ${ago(p.brief.generated_at)}${p.brief.model ? ` by ${p.brief.model}` : ''}. Claude reads this at the start of every session.</p>`
        : html`<p class="empty">No brief yet. It is written by the local LLM after enough sessions.</p>`}
      <h2>Open tasks</h2>${open.length ? html`<ul class="rows">${open.map(taskRow)}</ul>` : html`<p class="muted">None.</p>`}
      <h2>Recent sessions</h2><ul class="rows">${p.recent.map((s) => html`<li>${refLink(`S${s.id}`)}<span class="title" data-ref="S${s.id}">${clip(s.request, 120)}</span>
        <span class="side">${dayOf(s.created_at)}</span>${s.completed ? html`<span class="sub">${clip(s.completed, 180)}</span>` : ''}</li>`)}</ul>
      <p><a href="#/timeline?project=${encodeURIComponent(p.project)}">Full timeline for ${p.project}</a></p>
    </div><div>
      <h2>Notes</h2>${p.notes.length ? html`<ul class="files">${p.notes.map((n) => html`<li><a href="#" data-ref="I${n.id}">${n.title}</a><span class="muted">${ago(n.updated_at)}</span></li>`)}</ul>` : html`<p class="muted">None.</p>`}
      <h2>Most-edited files</h2><ul class="files">${p.files.map((f) => html`<li><span title="${f.file}">${f.file}</span><span class="num muted">${f.n}</span></li>`)}</ul>
      ${p.branches.length ? html`<h2>Branches</h2><ul class="files">${p.branches.map((b) => html`<li><span>${b.branch}</span><span class="muted">${ago(b.last)}</span></li>`)}</ul>` : ''}
      <h2>Kinds of observation</h2><p>${p.types.map((t) => html`${typeTag(t.type || 'other')} <span class="num muted">${t.n}</span> &nbsp;`)}</p>
    </div></div>`;
}

async function timelineView(params) {
  const project = params.get('project') || '';
  const kinds = params.get('kinds') || 'obs,sum,event';
  const projects = await api('/api/projects');
  view.innerHTML = html`<h1 class="page">Timeline</h1><p class="lede">What happened, newest first. Filled dots are session summaries, red squares are note and task changes.</p>
    <div class="toolbar"><select id="tproject" aria-label="Project"><option value="">All projects</option>${projects.map((p) => html`<option ${p.project === project ? raw('selected') : ''}>${p.project}</option>`)}</select>
      ${[['obs', 'Observations'], ['sum', 'Summaries'], ['event', 'Notes & tasks']].map(([k, l]) => html`<button class="chip" data-kind="${k}" aria-pressed="${kinds.includes(k)}">${l}</button>`)}</div>
    <div class="spine" id="spine"></div><button class="secondary more" id="more" hidden>Show older</button>`;
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
        <span class="t" data-ref="${ref}">${clip(r.title || '(untitled)', 140)}</span>
        <div class="d">${[!project && r.project, r.device, r.git_branch, r.subtitle && clip(r.subtitle, 160)].filter(Boolean).join(' · ')}</div>`.s;
      dayEl.append(e);
    }
    if (!rows.length && !before) $('#spine').innerHTML = html`<p class="empty">Nothing recorded yet for this filter.</p>`.s;
    $('#more').hidden = !next;
    $('#more').onclick = () => load(next);
  };
  await load();
}

const COLUMNS = [['todo', 'To do'], ['doing', 'Doing'], ['blocked', 'Blocked'], ['done', 'Done']];
async function projectOptions(selected) {
  const projects = await api('/api/projects');
  return html`<option value="">No project</option>${projects.map((p) => html`<option ${p.project === selected ? raw('selected') : ''}>${p.project}</option>`)}`;
}

async function tasksView(params) {
  const project = params.get('project') || '';
  const { result: tasks } = await api('/api/items/list', { kind: 'task', project: project || undefined, limit: 500 });
  const opts = await projectOptions(project);
  view.innerHTML = html`<h1 class="page">Tasks</h1><p class="lede">Durable to-dos Claude and you share across sessions and machines. Claude moves them with <code>task_update</code>.</p>
    <form class="composer" id="new-task"><div class="line"><input type="text" name="title" placeholder="New task, as an action" aria-label="New task" required>
      <select name="project" aria-label="Project">${opts}</select><select name="priority" aria-label="Priority"><option value="2">Normal</option><option value="1">High</option><option value="3">Low</option></select>
      <button type="submit">Add task</button></div></form>
    <div class="toolbar"><select id="filter-project" aria-label="Show project"><option value="">All projects</option>${raw(opts.s.replace('<option value="">No project</option>', ''))}</select></div>
    <div class="board">${COLUMNS.map(([st, label]) => {
      const col = tasks.filter((t) => t.status === st || (st === 'done' && t.status === 'cancelled'));
      return html`<section class="col"><h3><span>${label}</span><span class="num">${col.length}</span></h3><ol>${col.slice(0, st === 'done' ? 30 : 200).map((t) => html`
        <li class="task p${t.priority}"><span class="t" data-ref="I${t.id}">${t.title}</span>
          <div class="meta">${refLink(`I${t.id}`)}${!project && t.project ? html`<span>${t.project}</span>` : ''}${t.due_at ? html`<span>due ${dayOf(t.due_at)}</span>` : ''}<span>${ago(t.updated_at)}</span></div></li>`)}</ol></section>`;
    })}</div>`;
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
  view.innerHTML = html`<h1 class="page">Notes</h1><p class="lede">Decisions, conventions and gotchas worth keeping. Claude writes them with <code>note_add</code> and reads them at session start.</p>
    <form class="composer" id="new-note"><input type="text" name="title" placeholder="Note title" aria-label="Note title" required>
      <textarea name="body" placeholder="Details" aria-label="Details"></textarea>
      <div class="line"><select name="project" aria-label="Project">${opts}</select><button type="submit">Save note</button></div></form>
    ${notes.length ? html`<div class="grid">${notes.map((n) => html`<article class="card"><a class="cover" href="#" data-ref="I${n.id}" aria-label="${n.title}"></a>
      <h3>${n.title}</h3><p class="muted">${clip(n.body, 180)}</p><div class="meta">${refLink(`I${n.id}`)}<span>${n.project || 'no project'}</span><span>${ago(n.updated_at)}</span>${n.status === 'archived' ? html`<span>archived</span>` : ''}</div></article>`)}</div>`
      : html`<p class="empty">No notes yet.</p>`}`;
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
  view.innerHTML = html`<h1 class="page">Search</h1><p class="lede">The same full-text search Claude uses. Words match by prefix; all words first, then any.</p>
    <form class="toolbar" id="sform"><input type="search" name="q" value="${query}" placeholder="What are you looking for?" aria-label="Search" autofocus>
      <select name="kind" aria-label="Kind">${[['all', 'Everything'], ['observations', 'Observations'], ['summaries', 'Summaries'], ['notes', 'Notes'], ['tasks', 'Tasks']].map(([v, l]) => html`<option value="${v}" ${v === kind ? raw('selected') : ''}>${l}</option>`)}</select>
      <button type="submit">Search</button></form><div id="results"></div>`;
  $('#sform').addEventListener('submit', (e) => { e.preventDefault(); const f = new FormData(e.target); location.hash = `#/search?${q({ q: f.get('q'), kind: f.get('kind') })}`; });
  if (!query) return;
  const { result } = await api('/api/search', { query, kind, limit: 100 });
  $('#results').innerHTML = (result.length ? html`<ul class="rows">${result.map((r) => html`<li>${refLink(refOf(r))}<span class="title" data-ref="${refOf(r)}">${clip(r.title, 150)}</span>
    <span class="side">${dayOf(r.created_at)}</span><span class="sub">${r.project} · ${r.type}</span></li>`)}</ul>` : html`<p class="empty">No matches for “${query}”.</p>`).s;
}

async function sessionsView() {
  const rows = await api('/api/sessions?limit=150');
  view.innerHTML = html`<h1 class="page">Sessions</h1><p class="lede">Every Claude Code conversation, with the machine and branch it ran on.</p>
    <ul class="rows">${rows.map((x) => html`<li><span class="ref num">${dayOf(x.started_at).slice(5)}</span>
      <a class="title" href="#/session/${encodeURIComponent(x.session_id)}">${clip(x.first_request || x.first_prompt || '(no prompt)', 120)}</a>
      <span class="side">${ago(x.started_at)}</span><span class="sub">${[x.project, x.device, x.git_branch, `${x.prompt_counter} prompts`, `${x.obs} observations`].filter(Boolean).join(' · ')}</span></li>`)}</ul>`;
}

async function sessionView(id) {
  const s = await api(`/api/session?${q({ id })}`);
  const byPrompt = new Map();
  for (const o of s.observations) { if (!byPrompt.has(o.prompt_number)) byPrompt.set(o.prompt_number, []); byPrompt.get(o.prompt_number).push(o); }
  const sumBy = new Map(s.summaries.map((x) => [x.prompt_number, x]));
  view.innerHTML = html`<p><a href="#/sessions" class="muted">Sessions</a></p><h1 class="page">${s.session.project}</h1>
    <p class="lede">${[dayOf(s.session.started_at) + ' ' + timeOf(s.session.started_at), s.session.device, s.session.git_branch, s.session.cwd].filter(Boolean).join(' · ')}</p>
    <div class="spine">${s.prompts.map((p) => html`<section class="day"><h3>#${p.prompt_number}<small>${timeOf(p.created_at)}</small></h3>
      <div class="entry"><div class="t">${clip(p.text, 400)}</div></div>
      ${(byPrompt.get(p.prompt_number) || []).map((o) => html`<div class="entry">${refLink(`${o.id}`)} ${typeTag(o.type)} <span class="t" data-ref="${o.id}">${o.title}</span></div>`)}
      ${sumBy.get(p.prompt_number) ? html`<div class="entry sum">${refLink(`S${sumBy.get(p.prompt_number).id}`)} <span class="t" data-ref="S${sumBy.get(p.prompt_number).id}">${clip(sumBy.get(p.prompt_number).completed || 'Summary', 200)}</span></div>` : ''}
    </section>`)}</div>`;
}

// --- router -----------------------------------------------------------------------------------------
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
    if (err.message !== 'login required') view.innerHTML = html`<p class="empty">Could not load this page: ${err.message}</p>`.s;
  }
  document.title = `open-mem · ${name}`;
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

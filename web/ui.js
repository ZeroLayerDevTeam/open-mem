// Shared helpers of the web viewer: escaped templates, API calls, formatting, icons, pagination, light Markdown.
import { locale, t } from './i18n.js';

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// --- escaped templates: every interpolated value is escaped unless wrapped in raw() --------------------------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flat = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(flat).join('') : v === false || v == null ? '' : esc(v));
export const html = (strings, ...vals) => raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? flat(vals[i]) : ''), ''));
// Translated text that contains markup (<code>) of our own dictionary, never user data.
export const tr = (text, vars) => raw(t(text, vars));

// --- API ----------------------------------------------------------------------------------------------------------
export const LOGIN_REQUIRED = 'login required';
const cache = new Map();

export async function api(path, { body, signal } = {}) {
  const res = await fetch(path, body === undefined ? { credentials: 'same-origin', signal } : {
    method: 'POST', credentials: 'same-origin', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    window.dispatchEvent(new Event('om:login'));
    throw new Error(LOGIN_REQUIRED);
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (body !== undefined) cache.clear(); // a write can change any list
  return data;
}

// GET with a short in-memory cache, for data that many pages share (projects, filter menus).
export function cached(path, { signal, ttl = 60000 } = {}) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = api(path, { signal });
  cache.set(path, { at: Date.now(), promise });
  promise.catch(() => cache.delete(path));
  return promise;
}

export const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '' && v !== false)).toString();

// --- formatting -----------------------------------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
export const dayOf = (ms) => { const d = new Date(Number(ms)); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const timeOf = (ms) => { const d = new Date(Number(ms)); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const dateLong = (ms) => new Date(Number(ms)).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const dateShort = (ms) => new Date(Number(ms)).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
export const dateTime = (ms) => new Date(Number(ms)).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
export const fmt = (n) => Number(n || 0).toLocaleString(locale());

const UNITS = [['year', 31536e6], ['month', 2592e6], ['week', 6048e5], ['day', 864e5], ['hour', 36e5], ['minute', 6e4]];
export function ago(ms) {
  if (!ms) return t('never');
  const diff = Number(ms) - Date.now();
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto', style: 'short' });
  for (const [unit, size] of UNITS) if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit);
  return t('just now');
}
export function duration(ms) {
  const m = Math.round(Number(ms) / 60000);
  if (m < 1) return t('under a minute');
  if (m < 60) return t('{n} min', { n: m });
  return t('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 });
}

export const clip = (s, n) => { const v = String(s ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };
// One-line excerpt of Markdown text: markers dropped, then clipped.
export const excerpt = (s, n) => clip(String(s ?? '').replace(/^\s*(#{1,6}|[-*+]|\d+[.)])\s+/gm, '').replace(/\*\*|__|`/g, ''), n);
export const list = (v) => { if (!v) return []; try { const a = JSON.parse(v); return Array.isArray(a) ? a : [String(v)]; } catch { return [String(v)]; } };
export const refOf = (r) => (r.kind === 'sum' ? `S${r.id}` : r.kind === 'item' || r.kind === 'event' ? `I${r.id}` : `${r.id}`);

export const icon = (name, cls = '') => raw(`<svg class="i ${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`);
export const refLink = (ref) => html`<a class="ref" href="#" data-ref="${ref}" title="${t('Open record {ref}', { ref })}">${ref}</a>`;
export const typeTag = (type) => (type ? html`<span class="tag" data-type="${type}">${t(type)}</span>` : '');

// Project, machine and branch of a record, as quiet labelled items (no separators to read past).
export function metaItems({ project, device, branch, extra = [] } = {}) {
  return [
    project ? html`<a class="meta-item" href="#/project/${encodeURIComponent(project)}">${icon('folder')}${project}</a>` : '',
    device ? html`<span class="meta-item">${icon('device')}${device}</span>` : '',
    branch ? html`<span class="meta-item">${icon('branch')}${branch}</span>` : '',
    ...extra,
  ];
}

// Query words highlighted in already-plain text: escape first, then mark word starts (FTS matches by prefix).
export function highlight(text, query) {
  const terms = String(query || '').match(/[\p{L}\p{N}_]+/gu)?.filter((w) => w.length > 1) || [];
  const safe = esc(text);
  if (!terms.length) return raw(safe);
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(${terms.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  return raw(safe.split(/(&[#\w]+;)/).map((part, i) => (i % 2 ? part : part.replace(re, '<mark>$1</mark>'))).join(''));
}

// --- light Markdown for briefs, notes and summaries: escaped first, then a few block and inline forms ------------
const inline = (s) => s
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, '$1<em>$2</em>');

export function md(text) {
  if (!text) return '';
  const out = [];
  let listTag = null;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const closeList = () => { if (listTag) out.push(`</${listTag}>`); listTag = null; };
  const lines = esc(text).replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush(); closeList();
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (h) { flush(); closeList(); out.push(`<h4>${inline(h[2])}</h4>`); }
    else if (ul || ol) {
      flush();
      const tag = ul ? 'ul' : 'ol';
      if (listTag !== tag) { closeList(); out.push(`<${tag}>`); listTag = tag; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
    } else if (!line.trim()) { flush(); closeList(); }
    else { closeList(); para.push(line.trim()); }
  }
  flush(); closeList();
  return raw(out.join(''));
}

// --- pagination -----------------------------------------------------------------------------------------------------
// Page links around the current one, first and last always present; `href(page)` builds each link.
export function pager({ page, pageSize, total }, href) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize && page === 1) return '';
  const from = Math.min(total, (page - 1) * pageSize + 1);
  const to = Math.min(total, page * pageSize);
  const nums = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  if (page <= 3) [2, 3, 4].forEach((n) => n <= pages && nums.add(n));
  if (page >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach((n) => n >= 1 && nums.add(n));
  const sorted = [...nums].sort((a, b) => a - b);
  const items = [];
  sorted.forEach((n, i) => {
    if (i && n - sorted[i - 1] > 1) items.push(html`<span class="pg gap" aria-hidden="true">…</span>`);
    items.push(n === page
      ? html`<a class="pg" aria-current="page" href="${href(n)}">${fmt(n)}</a>`
      : html`<a class="pg" href="${href(n)}" aria-label="${t('Page {n}', { n })}">${fmt(n)}</a>`);
  });
  const step = (n, label, name) => (n < 1 || n > pages
    ? html`<span class="pg step" aria-disabled="true">${icon(name)}<span class="sr">${label}</span></span>`
    : html`<a class="pg step" href="${href(n)}" rel="${n < page ? 'prev' : 'next'}">${icon(name)}<span class="sr">${label}</span></a>`);
  return html`<nav class="pager" aria-label="${t('Pages')}">
    <p class="pager-sum">${t('{from}-{to} of {total}', { from: fmt(from), to: fmt(to), total: fmt(total) })}</p>
    <div class="pager-nav">${step(page - 1, t('Previous page'), 'chevron-left')}<span class="pg-nums">${items}</span>
      <span class="pg-compact">${t('Page {n} of {pages}', { n: fmt(page), pages: fmt(pages) })}</span>${step(page + 1, t('Next page'), 'chevron-right')}</div>
  </nav>`;
}

export const debounce = (fn, ms = 250) => {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
};

export function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.show = '1';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { delete el.dataset.show; }, 2600);
}

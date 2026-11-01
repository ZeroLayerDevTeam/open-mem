import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

// i18n.js touches localStorage, navigator and document at load: give it the bare minimum.
async function loadI18n(language) {
  const store = new Map([['om-lang', language]]);
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-GB' }, configurable: true });
  globalThis.document = { documentElement: { dataset: {}, lang: '' }, querySelectorAll: () => [] };
  return import(`../web/i18n.js?${language}`);
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\\'/g, "'");

test('every literal UI string of the web viewer has a Spanish translation', async () => {
  const { t } = await loadI18n('es');
  const app = read('app.js');
  const keys = new Set();
  for (const m of app.matchAll(/\btr?\('((?:[^'\\]|\\.)+)'/g)) keys.add(unescape(m[1]));
  // Literal labels handed to t() indirectly: metaList rows, sections, columns, options, titles, statuses.
  for (const m of app.matchAll(/\['[a-z]+', '([^']+)'\]/g)) keys.add(m[1]);
  for (const m of app.matchAll(/\[\d, '([A-Z][a-z]+)'\]/g)) keys.add(m[1]);
  for (const m of app.matchAll(/section\('([^']+)'/g)) keys.add(m[1]);
  for (const m of app.matchAll(/\['([A-Z][A-Za-z ]+)', r\./g)) keys.add(m[1]);
  for (const s of ['todo', 'doing', 'blocked', 'done', 'cancelled', 'active', 'archived', 'note', 'task', 'created', 'status', 'comment', 'edited'])
    keys.add(s);
  const html = read('index.html');
  for (const m of html.matchAll(/data-i18n(?:-html|-aria)?="([^"]+)"/g)) keys.add(unescape(m[1]));
  const missing = [...keys].filter((k) => t(k) === k && !['Commit', 'Prompt', 'Normal', '{n} prompts'].includes(k));
  assert.deepEqual(missing, []);
  assert.ok(keys.size > 100, `only ${keys.size} keys found: the scan is broken`);
});

test('t fills placeholders and falls back to English', async () => {
  const { t } = await loadI18n('es');
  assert.equal(t('{n} min ago', { n: 5 }), 'hace 5 min');
  assert.equal(t('not in the dictionary {x}', { x: 1 }), 'not in the dictionary 1');
  const en = await loadI18n('en');
  assert.equal(en.t('{n} min ago', { n: 5 }), '5 min ago');
});

// One interface over the local database and a shared open-mem server.
// Remote mode: reads and note/task writes go to the server; on a network failure they fall back to the
// local database (writes are then pushed by the next sync).
import { deviceName, log } from './config.mjs';
import { addItem, listItems, updateItem } from './items.mjs';
import { contextFor, getByRefs, recall, timeline } from './store.mjs';
import { hybridSearch } from './semantic.mjs';
import { remoteFetch } from './sync.mjs';

export const isNetworkError = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError'
  || /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|ETIMEDOUT/i.test(`${err?.message} ${err?.cause?.code || ''}`);

// The server is down or restarting behind a proxy: same as unreachable, the request never ran.
// (Not 504: the request may have run, and a local fallback would duplicate an added item.)
const isUnavailable = (err) => isNetworkError(err) || [502, 503].includes(err?.status);

// Plain functions shared by the server routes and local mode.
export const local = {
  search: (db, o, settings) => hybridSearch(db, o, settings),
  timeline: (db, { anchor, before, after }) => timeline(db, anchor, before ?? 5, after ?? 5),
  get: (db, { ids }) => getByRefs(db, ids || []),
  context: (db, { project, cwd, recap }, settings) => contextFor(db, project, settings, { cwd, recap }),
  recall: (db, { prompt, project, exclude, limit }) => recall(db, { prompt, project, exclude: new Set(exclude || []), limit }),
  itemsList: (db, o) => listItems(db, o),
  itemAdd: (db, o) => ({ id: addItem(db, o) }),
  itemUpdate: (db, { id, patch, device }) => updateItem(db, id, patch, { device }),
};

const ROUTES = {
  search: ['POST', '/api/search'],
  timeline: ['POST', '/api/timeline'],
  get: ['POST', '/api/get'],
  context: ['POST', '/api/context'],
  recall: ['POST', '/api/recall'],
  itemsList: ['POST', '/api/items/list'],
  itemAdd: ['POST', '/api/items/add'],
  itemUpdate: ['POST', '/api/items/update'],
};

// Returns { result, remote, fallback }.
export async function call(op, args, { db, settings }) {
  const withDevice = op === 'itemAdd' || op === 'itemUpdate' ? { device: deviceName(settings), ...args } : args;
  if (settings.mode === 'remote' && settings.serverUrl) {
    try {
      const [method, route] = ROUTES[op];
      const data = await remoteFetch(settings, method, route, withDevice);
      return { result: data.result, remote: true };
    } catch (err) {
      if (!isUnavailable(err)) throw err;
      log('warn', `server unreachable for ${op}, using local database: ${err.message}`);
      return { result: await local[op](db(), withDevice, settings), remote: false, fallback: true };
    }
  }
  return { result: await local[op](db(), withDevice, settings), remote: false };
}

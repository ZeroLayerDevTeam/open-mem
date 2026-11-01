// Optional LLM compression. Never uses the user's Claude subscription:
// a local Ollama, any OpenAI-compatible endpoint the user configures, or none.
import { ollamaTimings } from './llmstats.mjs';

const OLLAMA_DEFAULT = 'http://127.0.0.1:11434';
// gemma3 measured best at skipping trivial calls and fastest on a 16 GB GPU.
const PREFERRED = [/gemma/i, /qwen/i, /llama/i, /mistral/i, /phi/i];

async function fetchJson(url, { body, headers = {}, timeoutMs }) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

export function pickOllamaModel(names, wanted) {
  if (wanted && names.includes(wanted)) return wanted;
  const chat = names.filter((n) => !/embed|bge|nomic|minilm/i.test(n));
  for (const re of PREFERRED) {
    const hit = chat.find((n) => re.test(n));
    if (hit) return hit;
  }
  return chat[0] || null;
}

// Returns { kind: 'ollama'|'openai'|'none', model, baseUrl, apiKey, reason }
export async function resolveProvider(settings) {
  const p = settings.provider || 'auto';
  if (p === 'none') return { kind: 'none', reason: 'provider=none' };
  if (p === 'openai') {
    if (!settings.baseUrl || !settings.model) return { kind: 'none', reason: 'openai provider needs baseUrl and model' };
    return { kind: 'openai', model: settings.model, baseUrl: settings.baseUrl.replace(/\/+$/, ''), apiKey: settings.apiKey };
  }
  const baseUrl = (settings.baseUrl || OLLAMA_DEFAULT).replace(/\/+$/, '');
  try {
    const tags = await fetchJson(`${baseUrl}/api/tags`, { timeoutMs: 2500 });
    const model = pickOllamaModel((tags.models || []).map((m) => m.name), settings.model);
    if (model) return { kind: 'ollama', model, baseUrl, keepAlive: settings.llmKeepAlive || undefined };
    return { kind: 'none', reason: `Ollama at ${baseUrl} has no chat model (run: ollama pull qwen3:8b)` };
  } catch (err) {
    return { kind: 'none', unreachable: true, reason: `Ollama not reachable at ${baseUrl} (${err.message})` };
  }
}

export function parseJsonReply(text) {
  const cleaned = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`LLM reply has no JSON object: ${cleaned.slice(0, 200)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

// Frees the (V)RAM of every model the Ollama at baseUrl has loaded. Returns the names unloaded.
export async function unloadOllama(baseUrl = OLLAMA_DEFAULT) {
  baseUrl = (baseUrl || OLLAMA_DEFAULT).replace(/\/+$/, '');
  const ps = await fetchJson(`${baseUrl}/api/ps`, { timeoutMs: 2500 });
  const names = (ps.models || []).map((m) => m.name);
  for (const model of names) {
    await fetchJson(`${baseUrl}/api/generate`, { timeoutMs: 15000, body: { model, keep_alive: 0 } });
  }
  return names;
}

// One chat call that must answer a JSON object. When the provider carries a recorder (provider.record, see
// llmstats.mjs), every call is reported with its timings, also the failed ones.
export async function completeJson(provider, system, user, timeoutMs = 120000) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const started = Date.now();
  const report = (extra) => provider.record?.({ at: started, task: TASKS.get(system) || 'other', provider: provider.kind, model: provider.model, ...extra });
  let res;
  let timings;
  try {
    if (provider.kind === 'ollama') {
      res = await fetchJson(`${provider.baseUrl}/api/chat`, {
        timeoutMs,
        body: { model: provider.model, messages, stream: false, format: 'json', think: false,
          keep_alive: provider.keepAlive, options: { temperature: 0.2, num_ctx: 8192 } },
      });
      timings = ollamaTimings(res);
    } else if (provider.kind === 'openai') {
      const headers = provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
      const body = { model: provider.model, messages, temperature: 0.2, response_format: { type: 'json_object' } };
      try {
        res = await fetchJson(`${provider.baseUrl}/chat/completions`, { body, headers, timeoutMs });
      } catch (err) {
        if (err.status !== 400) throw err;
        delete body.response_format; // some compatible servers reject it
        res = await fetchJson(`${provider.baseUrl}/chat/completions`, { body, headers, timeoutMs });
      }
      timings = { prompt_tokens: res.usage?.prompt_tokens ?? null, output_tokens: res.usage?.completion_tokens ?? null };
    } else throw new Error('No LLM provider available');
  } catch (err) {
    report({ ok: false, total_ms: Date.now() - started, error: err.message });
    throw err;
  }
  timings.total_ms ??= Date.now() - started;
  try {
    const out = parseJsonReply(provider.kind === 'ollama' ? res.message?.content : res.choices?.[0]?.message?.content);
    report({ ok: true, ...timings });
    return out;
  } catch (err) {
    report({ ok: false, ...timings, error: err.message }); // the model ran, its answer was unusable
    throw err;
  }
}

export const OBSERVATION_SYSTEM = `You record long-term memory for a coding assistant.
You receive ONE tool call the assistant made while working on the user's request.
Decide whether it holds something worth remembering in future sessions: a decision, a discovery about the code or system,
a bug and its cause or fix, a feature or config change, where something lives, a gotcha.
Most tool calls are NOT worth it. Skip when the call is routine: listing or globbing files, a read or search
whose output shows nothing surprising, a command that just succeeded with ordinary output, a failed lookup.
Keep it only if a future session would genuinely benefit from knowing it.
Write title, subtitle, narrative and facts in the SAME LANGUAGE as the user's request (Spanish request -> Spanish).
Be concrete: names, paths, values, error strings.
Reply with ONLY a JSON object:
{"skip": false, "type": "discovery|decision|bugfix|feature|refactor|change", "title": "short title",
 "subtitle": "one sentence", "narrative": "2-5 sentences", "facts": ["atomic fact", "..."], "concepts": ["keyword", "..."]}
or {"skip": true}`;

export const SUMMARY_SYSTEM = `You summarize one turn of work between a user and a coding assistant for long-term memory.
You receive the user's request, the observations recorded during the turn and the assistant's final message.
Write in the same language as the user's request. Be concrete. If nothing meaningful happened, skip.
Reply with ONLY a JSON object:
{"skip": false, "request": "what the user asked", "investigated": "...", "learned": "...", "completed": "...",
 "next_steps": "...", "notes": "..."}
or {"skip": true}`;

export const NOTES_REVIEW_SYSTEM = `You review the durable notes a coding assistant keeps for one project.
You receive the project brief and the notes (id, last update date, title, body), newest first.
Flag only real problems a reader must resolve: two notes that contradict each other, a note that a newer one or the brief
clearly supersedes (outdated), or two notes that say the same thing (duplicate). Do not flag notes that merely differ in topic.
Write each reason in one short sentence, in the same language as the notes, naming what conflicts.
Reply with ONLY a JSON object: {"flags": [{"ids": ["I12", "I30"], "kind": "contradiction|outdated|duplicate", "reason": "..."}]}
or {"flags": []}`;

export const BRIEF_SYSTEM =`You maintain a short project brief that a coding assistant reads at the start of every session,
so it can start working without re-exploring the project. You receive the previous brief (may be empty), recent
session summaries, open tasks, notes and the most-edited files.
Write the brief in the same language as the summaries. At most 1200 characters, markdown bullets, no preamble.
Cover: what the project is and its stack; how to build/test/run if known; current state and focus; key decisions,
conventions and gotchas; where important things live. Drop anything outdated. Never include secrets.
Reply with ONLY a JSON object: {"brief": "..."}`;

export const LESSONS_SYSTEM = `You find lessons worth writing down in a project's "known mistakes" list.
You receive the bug fixes recorded for one project (id, date, session, title, one-line detail), newest first.
Find mistakes that came back: the same root cause or the same wrong approach fixed in two or more different sessions.
For each, write one rule a developer can follow to avoid it next time: imperative, concrete (names, paths, commands,
error strings), at most 220 characters, in the same language as the records. Ignore one-off bugs.
Reply with ONLY a JSON object: {"lessons": [{"ids": ["123", "456"], "rule": "..."}]} or {"lessons": []}`;

// Which job a call does, from its system prompt (for the stats of the web viewer's LLM page).
const TASKS = new Map([[OBSERVATION_SYSTEM, 'observation'], [SUMMARY_SYSTEM, 'summary'], [NOTES_REVIEW_SYSTEM, 'review'], [BRIEF_SYSTEM, 'brief'], [LESSONS_SYSTEM, 'lessons']]);

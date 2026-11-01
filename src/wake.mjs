// Wake-on-LAN for the machine that runs the LLM. A shared server whose Ollama lives on another machine (reached
// through a tunnel) wakes that machine when queued work waits for the LLM, starts a drain once the LLM answers, and
// turns the machine off again `wakeOffMinutes` after the last LLM call. Only a machine this server woke is turned off,
// and the off command itself decides whether the machine is free (nobody at the keyboard, no session open).
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { log } from './config.mjs';
import { getMeta, setMeta } from './db.mjs';

const RESEND_MS = 5 * 60000; // a machine still asleep after this gets another magic packet
const OFF_TIMEOUT_MS = 60000;
const IN_USE = 3; // exit code of the off command: the machine is in use, leave it on

export function parseMac(mac) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error(`invalid MAC address: ${mac}`);
  return Buffer.from(hex, 'hex');
}

// 6 x 0xFF, then the MAC 16 times.
export function magicPacket(mac) {
  const m = parseMac(mac);
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => m)]);
}

export function sendMagicPacket(mac, broadcast = '255.255.255.255', port = 9) {
  const packet = magicPacket(mac);
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', (err) => { sock.close(); reject(err); });
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(packet, port, broadcast, (err) => { sock.close(); if (err) reject(err); else resolve(); });
    });
  });
}

// Runs the user's off command through the shell; resolves with its exit code and first output line.
export function runOffCommand(command) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), OFF_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, out: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out: out.trim().split(/\r?\n/)[0] || '' }); });
  });
}

const pendingCount = (db) => db.prepare("SELECT count(*) n FROM queue WHERE status IN ('pending', 'processing')").get().n;
const lastLlmCall = (db) => db.prepare('SELECT max(at) at FROM llm_calls').get().at || 0;
const STATE = ['wake_sent_at', 'wake_woke_at', 'wake_up_at', 'wake_off_tried_at'];
const meta = (db, key) => Number(getMeta(db, key) || 0);
const clear = (db) => { for (const k of STATE) setMeta(db, k, 0); };

// One step of the wake cycle; `serve` calls it every 30 s. Returns what it did (for logs and tests).
// deps: llmUp() -> bool, drainerRunning() -> bool, startDrainer(), wake(mac, broadcast), off(command) -> { code, out }.
export async function wakeTick(db, settings, deps, now = Date.now()) {
  if (!settings.wakeMac) return 'off';
  const pending = pendingCount(db);
  const wokeAt = meta(db, 'wake_woke_at');
  if (!(await deps.llmUp())) {
    if (!pending) return 'asleep';
    if (now - meta(db, 'wake_sent_at') < RESEND_MS) return 'waking';
    await deps.wake(settings.wakeMac, settings.wakeBroadcast);
    setMeta(db, 'wake_sent_at', now);
    if (!wokeAt) setMeta(db, 'wake_woke_at', now);
    log('info', `wake-on-lan sent to ${settings.wakeMac}: ${pending} queue item(s) wait for the LLM`);
    return 'woken';
  }
  // The LLM answers. A machine that was already on when work came in is not ours to turn off.
  if (!wokeAt) return 'on';
  if (!meta(db, 'wake_up_at')) setMeta(db, 'wake_up_at', now);
  if (pending || deps.drainerRunning()) {
    if (pending && !deps.drainerRunning()) deps.startDrainer();
    return 'working';
  }
  const quietSince = Math.max(meta(db, 'wake_up_at'), lastLlmCall(db), meta(db, 'wake_off_tried_at'));
  if (now - quietSince < settings.wakeOffMinutes * 60000) return 'cooling';
  if (!settings.wakeOffCommand) { clear(db); return 'kept'; }
  const { code, out } = await deps.off(settings.wakeOffCommand);
  if (code === 0 || code === IN_USE) {
    log('info', code === 0 ? `LLM machine turned off after the queue run: ${out}` : `LLM machine left on, in use: ${out}`);
    clear(db);
    return code === 0 ? 'turned-off' : 'in-use';
  }
  log('warn', `wake off command failed (exit ${code}): ${out}`);
  setMeta(db, 'wake_off_tried_at', now); // try again after another quiet period
  return 'off-failed';
}

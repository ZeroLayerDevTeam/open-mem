// Secret redaction applied before anything is queued, stored, or sent to an LLM.
// Conservative patterns: better to lose a little context than to persist a credential.

const R = '[REDACTED]';

const PATTERNS = [
  [/<private>[\s\S]*?<\/private>/gi, '[private]'],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, `${R} private key`],
  [/\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}/g, R], // Anthropic / OpenAI / OpenRouter
  [/\bctx7sk-[A-Za-z0-9-]{20,}/g, R], // Context7
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, R], // GitHub
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, R],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, R], // GitLab
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, R], // AWS access key id
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, R], // Slack
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, R], // Google API key
  [/\b1\/\/0[A-Za-z0-9_-]{30,}/g, R], // Google OAuth refresh token
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, R], // Google OAuth access token
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g, R], // Telegram bot token
  [/\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g, R], // Stripe
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, R], // JWT
  [/(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, `$1${R}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${R}@`], // user:pass@host
  // key = value / "key": "value" for secret-looking names
  [/(\b[A-Za-z0-9_-]*(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',;}{]{6,})/gi, `$1${R}`],
];

export function redactText(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

// Deep redaction of tool input/output objects.
export function redact(value, depth = 0) {
  if (typeof value === 'string') return redactText(value);
  if (depth > 20 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = /^(password|passwd|secret|token|api[_-]?key|apikey|authorization|client_secret)$/i.test(k) && typeof v === 'string' && v
      ? R
      : redact(v, depth + 1);
  }
  return out;
}

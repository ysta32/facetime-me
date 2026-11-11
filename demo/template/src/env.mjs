// Small helpers the dashboard's auth uses. The tests in tests/ cover them.
export function requireEnv(name, env = process.env) {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadEnvFile(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function parseCookie(header = '') {
  return Object.fromEntries(header.split(';').map(p => p.trim()).filter(Boolean).map(p => {
    const i = p.indexOf('=');
    return i < 0 ? [p, ''] : [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
  }));
}

export function sessionExpiry(now, maxAgeSeconds) {
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) throw new Error('maxAge must be positive');
  return new Date(now.getTime() + maxAgeSeconds * 1000);
}

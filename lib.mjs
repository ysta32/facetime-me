import { createHmac, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = dirname(fileURLToPath(import.meta.url));
export const STATE = join(HOME, 'state');
export const CONFIG_PATH = join(HOME, 'config.json');
export const AGENT_NAME = 'claude-code-facetime';
export const API = 'https://app.trychert.com/api/v1';
mkdirSync(STATE, { recursive: true, mode: 0o700 });

/** Secrets live in two 0600 files and are only ever put in process.env, never printed. */
export function loadSecrets() {
  for (const file of ['.env.livekit', '.env.local']) {
    const path = join(HOME, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

/** config.json (written by `facetime-me --setup`): projectId, plus phone and lineId for outbound alerts. */
export const config = () => readJson(CONFIG_PATH, {});

export const log = (message) => {
  appendFileSync(join(STATE, 'facetime-me.log'), `${new Date().toISOString()} ${message}\n`);
};

export function writeJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 1), { mode: 0o600 });
  renameSync(temp, path);
}

export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export const resultPath = (room) => join(STATE, `${room}.json`);
export const demoFeed = join(STATE, 'demo-events.log');
export const demoEvent = (text) => { try { appendFileSync(demoFeed, `${text}\n`); } catch { /* the terminal view is optional */ } };

export async function chert(method, path, body, { idempotencyKey } = {}) {
  const { projectId } = config();
  const headers = { authorization: `Bearer ${process.env.CHERT_API_KEY}`, 'x-chert-project-id': projectId };
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    headers['idempotency-key'] = idempotencyKey ?? randomUUID();
  }
  const response = await fetch(`${API}${path}`, { method, headers, redirect: 'error', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* reported below */ }
  if (!response.ok) {
    const code = json?.error?.code ?? json?.code ?? json?.error ?? text.slice(0, 200);
    const error = new Error(`Chert ${method} ${path}: HTTP ${response.status} ${typeof code === 'string' ? code : JSON.stringify(code)}`);
    error.status = response.status;
    throw error;
  }
  return json?.data ?? json;
}

/** Chert requires exp - nbf <= 7200, which the LiveKit SDK's nbf=0 cannot satisfy, so the bridge token is signed here. */
export function bridgeToken(room, identity, ttlSeconds = 900) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: process.env.LIVEKIT_API_KEY, sub: identity, nbf: now - 10, exp: now + ttlSeconds, video: { room, roomJoin: true, canPublish: true, canSubscribe: true } };
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${head}.${createHmac('sha256', process.env.LIVEKIT_API_SECRET).update(head).digest('base64url')}`;
}

export const homeDir = homedir();

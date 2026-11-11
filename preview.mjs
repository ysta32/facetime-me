// facetime-me --preview: the call screen in your browser, without placing a call. The page asks this
// server for frames from the same renderer the call uses, plays voice samples for each personality,
// and saves the ones you pick to config.json (the next call uses them).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { CONFIG_PATH, HOME, STATE, config, loadSecrets, writeJson } from './lib.mjs';
import { loadFrames } from './bake.mjs';
import { Mascot } from './mascot.mjs';
import { customPersona, DEFAULT_PERSONA, PERSONAS, VOICES } from './personas.mjs';
import { LH, LW, SAFE, THEMES } from './scene.mjs';

const VOICE_CACHE = join(STATE, 'voices');
const DEMO_FEED = join(STATE, 'demo-events.log');
let callStartedAt = null;

// What each scene puts on screen. The real call drives the same looks and cards.
const SCENES = {
  hello: { label: 'You call it', look: 'greeting', then: 'idle', card: null },
  approve: { label: 'It asks permission', look: 'waiting', card: { kind: 'approve', title: 'Can I do this?', command: 'git push origin main', lines: ['Push the login fix to GitHub'] } },
  failed: { label: 'Something broke', look: 'error', card: { kind: 'error', title: 'Tests failed', lines: ['auth.test.js: 2 failing', 'expected 200, got 401'] } },
  fixing: { label: 'Fixing it live', look: 'reading', card: { kind: 'reading', input: { file_path: 'src/auth/login.js' }, output: 'export async function login(user) {\n  const token = await sign(user);\n  return { token };\n}' } },
  done: { label: 'All fixed', look: 'done', card: { kind: 'done', title: 'Fixed', tests: { pass: 6, fail: 0 }, lines: ['Login works again'] } },
};

let frames;
const mascots = new Map();
function mascotFor(theme, scene) {
  const key = `${theme}:${scene}`;
  let entry = mascots.get(key);
  if (!entry) {
    const mascot = new Mascot({ frames, theme });
    mascot.scene.gridOnly = true;
    mascot.footer('my-app');
    const s = SCENES[scene] ?? SCENES.approve;
    mascot.play(s.look);
    mascot.card(s.card);
    entry = { mascot, scene: s, since: Date.now() };
    mascots.set(key, entry);
  }
  // A greeting waves once, then settles; replay it every few seconds so the preview keeps showing it.
  if (entry.scene.then) {
    const t = Date.now() - entry.since;
    if (t > 6000) { entry.mascot.play(entry.scene.look); entry.since = Date.now(); }
    else if (entry.mascot.finished()) entry.mascot.play(entry.scene.then);
  }
  return entry.mascot;
}

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise(resolve => { let data = ''; req.on('data', c => { data += c; }); req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } }); });

/** A spoken sample of a personality, made once with OpenAI's speech model and cached. */
async function voiceSample(personaId, voice, style) {
  const persona = personaId === 'custom' && style ? customPersona(String(style).slice(0, 400)) : PERSONAS[personaId];
  if (!persona) throw Object.assign(new Error('unknown personality'), { status: 404 });
  voice = VOICES.includes(voice) ? voice : persona.voice;
  mkdirSync(VOICE_CACHE, { recursive: true });
  const key = createHash('sha1').update(`${persona.sample}|${persona.tone}|${voice}|${config().speed ?? 1.1}|brisk`).digest('hex').slice(0, 12);
  const file = join(VOICE_CACHE, `${personaId}-${voice}-${key}.mp3`);
  if (existsSync(file)) return readFileSync(file);
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('No OpenAI key yet: run facetime-me --setup'), { status: 400 });
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: persona.sample, instructions: `${persona.tone} Talk at a brisk, quick pace.`, speed: Math.min(1.5, Math.max(0.8, Number(config().speed) || 1.1)), response_format: 'mp3' }),
  });
  if (!response.ok) throw Object.assign(new Error(`OpenAI could not voice "${voice}" (HTTP ${response.status})`), { status: 502 });
  const audio = Buffer.from(await response.arrayBuffer());
  writeFileSync(file, audio);
  return audio;
}

const ELEVEN_DEFAULT = 'bIHbv24MWmeRgasZH58o';
let elevenVoices = null;
const BUILT_IN_VOICES = [
  ['bIHbv24MWmeRgasZH58o', 'Will', 'male, young, relaxed'], ['TX3LPaxmHKxFdv7VOQHJ', 'Liam', 'male, young, energetic'],
  ['IKne3meq5aSn9XLyUdCD', 'Charlie', 'male, Australian, playful'], ['iP95p4xoKVk53GoZ742B', 'Chris', 'male, casual, down to earth'],
  ['cjVigY5qzO86Huf0OWal', 'Eric', 'male, smooth, friendly'], ['nPczCjzI2devNBz1zQrb', 'Brian', 'male, deep, calm'],
  ['cgSgspJ2msm6clMCkdW9', 'Jessica', 'female, young, playful'], ['FGY2WhTYpPnrIDTdsKH5', 'Laura', 'female, young, upbeat'],
  ['EXAVITQu4vr4xnSDxMaL', 'Sarah', 'female, warm, confident'], ['Xb7hH8MSUJpSbSDYk0k2', 'Alice', 'female, British, clear'],
  ['SAz9YHcvj6GT2YYXdXww', 'River', 'neutral, relaxed'], ['XrExE9yKIg1WjnnlVkGX', 'Matilda', 'female, warm, friendly'],
].map(([id, name, about]) => ({ id, name, about }));
async function elevenList() {
  if (!process.env.ELEVENLABS_API_KEY) return null;
  if (elevenVoices) return elevenVoices;
  const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(15000) });
  // A key without voices_read can still speak: offer ElevenLabs' built-in voices.
  if (res.status === 401) return (elevenVoices = BUILT_IN_VOICES);
  if (!res.ok) throw Object.assign(new Error(`ElevenLabs would not list voices (HTTP ${res.status})`), { status: 502 });
  const { voices } = await res.json();
  elevenVoices = voices.map(v => ({ id: v.voice_id, name: v.name.split(' - ')[0], about: [v.labels?.gender, v.labels?.age, v.labels?.accent, v.labels?.descriptive ?? v.labels?.description].filter(Boolean).join(', ') }));
  return elevenVoices;
}

/** The personality's sample line in an ElevenLabs voice (Flash, the model the calls use), cached. */
async function elevenSample(personaId, voiceId) {
  const persona = PERSONAS[personaId] ?? PERSONAS[DEFAULT_PERSONA];
  if (!/^[A-Za-z0-9]{10,40}$/.test(voiceId ?? '')) throw Object.assign(new Error('unknown voice'), { status: 404 });
  const speed = Math.min(1.2, Math.max(0.7, Number(config().speed) || 1.1));
  mkdirSync(VOICE_CACHE, { recursive: true });
  const file = join(VOICE_CACHE, `el-${voiceId}-${createHash('sha1').update(`${persona.sample}|${speed}`).digest('hex').slice(0, 12)}.mp3`);
  if (existsSync(file)) return readFileSync(file);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text: persona.sample, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true, speed } }),
  });
  if (!res.ok) throw Object.assign(new Error(`ElevenLabs could not voice that (HTTP ${res.status})`), { status: 502 });
  const audio = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, audio);
  return audio;
}

function choices() {
  const c = config();
  const personality = PERSONAS[c.personality] || (c.personality === 'custom' && c.customStyle) ? c.personality : DEFAULT_PERSONA;
  return { theme: THEMES[c.theme] ? c.theme : 'night', personality, voice: c.voice ?? null, customStyle: c.customStyle ?? '', elevenVoice: c.elevenVoice ?? ELEVEN_DEFAULT, eleven: Boolean(process.env.ELEVENLABS_API_KEY) && c.tts !== 'openai' };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(readFileSync(join(HOME, 'preview', 'index.html')));
  }
  if (url.pathname === '/api/options') {
    return json(res, 200, {
      grid: { width: LW, height: LH, safe: SAFE },
      themes: Object.entries(THEMES).map(([id, t]) => ({ id, name: t.name })),
      personas: [...Object.entries(PERSONAS), ['custom', customPersona('')]].map(([id, p]) => ({ id, name: p.name, kind: p.kind, blurb: p.blurb, voice: p.voice, sample: p.sample, lines: p.lines })),
      voices: VOICES, scenes: Object.entries(SCENES).map(([id, s]) => ({ id, label: s.label })), chosen: choices(),
    });
  }
  if (url.pathname === '/api/frame') {
    const theme = THEMES[url.searchParams.get('theme')] ? url.searchParams.get('theme') : 'night';
    const px = mascotFor(theme, url.searchParams.get('scene')).render();
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    return res.end(Buffer.from(px.buffer, px.byteOffset, px.byteLength));
  }
  if (url.pathname === '/api/voice') {
    try {
      const audio = await voiceSample(url.searchParams.get('persona'), url.searchParams.get('voice'), url.searchParams.get('style'));
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
      return res.end(audio);
    } catch (error) { return json(res, error.status ?? 500, { error: error.message }); }
  }
  if (url.pathname === '/api/eleven/voices') {
    try { return json(res, 200, { voices: await elevenList() }); } catch (error) { return json(res, error.status ?? 500, { error: error.message }); }
  }
  if (url.pathname === '/api/eleven/voice') {
    try {
      const audio = await elevenSample(url.searchParams.get('persona'), url.searchParams.get('voice'));
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
      return res.end(audio);
    } catch (error) { return json(res, error.status ?? 500, { error: error.message }); }
  }
  if (url.pathname === '/api/choose' && req.method === 'POST') {
    const body = await readBody(req), next = config();
    if (typeof body.elevenVoice === 'string' && /^[A-Za-z0-9]{10,40}$/.test(body.elevenVoice)) next.elevenVoice = body.elevenVoice;
    if (body.theme && THEMES[body.theme]) next.theme = body.theme;
    if (body.personality === 'custom' && String(body.customStyle ?? '').trim()) { next.personality = 'custom'; next.customStyle = String(body.customStyle).trim().slice(0, 400); delete next.voice; }
    else if (body.personality && PERSONAS[body.personality]) { next.personality = body.personality; delete next.voice; }
    const base = next.personality === 'custom' ? 'verse' : (PERSONAS[next.personality] ?? PERSONAS[DEFAULT_PERSONA]).voice;
    if ('voice' in body) { if (VOICES.includes(body.voice) && body.voice !== base) next.voice = body.voice; else delete next.voice; }
    writeJson(CONFIG_PATH, next);
    return json(res, 200, { chosen: choices() });
  }
  if (url.pathname === '/api/call' && req.method === 'POST') {
    const lock = join(STATE, 'call.lock');
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 8 * 60000) return json(res, 409, { error: 'A call is already in progress. Hang up, wait a few seconds, then try again.' });
    rmSync(lock, { recursive: true, force: true });
    writeFileSync(DEMO_FEED, '');
    callStartedAt = Date.now();
    // --demo opens its own big-font Terminal window, counts down 5 s, then breaks a build and rings you.
    spawn(process.execPath, [join(HOME, 'bin', 'facetime-me.mjs'), '--demo'], { cwd: HOME, stdio: 'ignore', detached: true }).unref();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/call') {
    const events = existsSync(DEMO_FEED) ? readFileSync(DEMO_FEED, 'utf8').split('\n').map(l => l.trim()).filter(Boolean) : [];
    return json(res, 200, { startedAt: callStartedAt, events, busy: existsSync(join(STATE, 'call.lock')) });
  }
  json(res, 404, { error: 'not found' });
}

export async function preview({ open = true } = {}) {
  loadSecrets();
  frames = loadFrames();
  const server = createServer((req, res) => handle(req, res).catch(error => json(res, 500, { error: error.message })));
  let port = Number(process.env.FACETIME_ME_PREVIEW_PORT) || 4777;
  await new Promise((resolve, reject) => {
    server.on('error', error => { if (error.code === 'EADDRINUSE' && port < 4800) server.listen(++port, '127.0.0.1'); else reject(error); });
    server.on('listening', resolve);
    server.listen(port, '127.0.0.1');
  });
  const address = `http://127.0.0.1:${port}`;
  console.log(`facetime-me · preview at ${address} (Ctrl+C to stop). Picks save to config.json; the next call uses them.`);
  if (open && !process.env.FACETIME_ME_NO_OPEN) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [address], { stdio: 'ignore', detached: true }).unref();
  return server;
}

if (process.argv[1] && process.argv[1].endsWith('preview.mjs')) await preview();

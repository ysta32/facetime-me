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
import { instructionsFor, tagsFor } from './prompt.mjs';
import { startWhisper, transcribe } from './stt.mjs';
let whisperOn = false;
import { LH, LW, SAFE, THEMES } from './scene.mjs';

const VOICE_CACHE = join(STATE, 'voices');
const DEMO_FEED = join(STATE, 'demo-events.log');
let callStartedAt = null;

// What each scene puts on screen. The real call drives the same looks and cards.
const SCENES = {
  hello: { label: 'You call it', look: 'greeting', then: 'idle', card: null, react: { sparkles: 5 } },
  yes: { label: 'You say yes', look: 'waiting', card: { kind: 'waiting', title: 'Push to main?' }, react: { hearts: 3, hop: true } },
  approve: { label: 'It asks permission', look: 'waiting', card: { kind: 'approve', title: 'Can I do this?', command: 'git push origin main', lines: ['Push the login fix to GitHub'] } },
  failed: { label: 'Something broke', look: 'error', card: { kind: 'error', title: 'Tests failed', lines: ['auth.test.js: 2 failing', 'expected 200, got 401'] } },
  fixing: { label: 'Fixing it live', look: 'reading', card: { kind: 'reading', input: { file_path: 'src/auth/login.js' }, output: 'export async function login(user) {\n  const token = await sign(user);\n  return { token };\n}' } },
  done: { label: 'All fixed', look: 'done', card: { kind: 'done', title: 'Shipped', tests: { pass: 12, fail: 0 }, lines: ['Live on staging'] }, react: { sparkles: 8, hop: true } },
};

let frames;
const mascots = new Map();
// The practice call drives one shared look; every theme's live mascot follows it.
const live = { look: 'idle', card: null, react: null, at: 0, chat: [] };
const liveMascots = new Map();
function liveMascot(theme) {
  let entry = liveMascots.get(theme);
  if (!entry) { const mascot = new Mascot({ frames, theme }); mascot.scene.gridOnly = true; mascot.footer('my-app'); entry = { mascot, at: -1 }; liveMascots.set(theme, entry); }
  if (entry.chatAt !== live.chatAt) { entry.mascot.clearChat(); for (const m of live.chat) entry.mascot.scene.say(m.who, m.text, m.id, m.at); entry.chatAt = live.chatAt; }
  if (entry.at !== live.at) { entry.mascot.play(live.look); entry.mascot.card(live.card); if (live.react) entry.mascot.react(live.react); entry.at = live.at; }
  return entry.mascot;
}

function mascotFor(theme, scene) {
  if (scene === 'live') return liveMascot(theme);
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
  // Hearts and hops replay every few seconds so the preview keeps showing them.
  if (entry.scene.react && Date.now() - (entry.reactedAt ?? 0) > 2600) { entry.mascot.react(entry.scene.react); entry.reactedAt = Date.now(); }
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
  const model = config().elevenModel || 'eleven_flash_v2_5', tag = tagsFor(config())[0];
  const text = tag ? `[${tag}] ${persona.sample}` : persona.sample;
  if (!/^[A-Za-z0-9]{10,40}$/.test(voiceId ?? '')) throw Object.assign(new Error('unknown voice'), { status: 404 });
  const speed = Math.min(1.2, Math.max(0.7, Number(config().speed) || 1.1));
  mkdirSync(VOICE_CACHE, { recursive: true });
  const file = join(VOICE_CACHE, `el-${voiceId}-${createHash('sha1').update(`${text}|${speed}|${model}|v3`).digest('hex').slice(0, 12)}.mp3`);
  if (existsSync(file)) return readFileSync(file);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true, speed } }),
  });
  if (!res.ok) throw Object.assign(new Error(`ElevenLabs could not voice that (HTTP ${res.status})`), { status: 502 });
  const audio = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, audio);
  return audio;
}

function choices() {
  const c = config();
  const personality = PERSONAS[c.personality] || (c.personality === 'custom' && c.customStyle) ? c.personality : DEFAULT_PERSONA;
  return { theme: THEMES[c.theme] ? c.theme : 'night', personality, voice: c.voice ?? null, customStyle: c.customStyle ?? '', elevenVoice: c.elevenVoice ?? ELEVEN_DEFAULT, eleven: Boolean(process.env.ELEVENLABS_API_KEY) && c.tts !== 'openai', elevenModel: c.elevenModel || 'eleven_flash_v2_5', tags: tagsFor(c) };
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
  if (url.pathname === '/api/practice/scenarios') {
    const scenarios = practiceScenarios(personaFrom({ persona: url.searchParams.get('persona'), customStyle: url.searchParams.get('style') }));
    return json(res, 200, { scenarios: Object.entries(scenarios).map(([id, s]) => ({ id, label: s.label, opener: s.opener, facts: s.facts })) });
  }
  if (url.pathname === '/api/practice/start' && req.method === 'POST') return json(res, 200, await practiceStart(await readBody(req)));
  if (url.pathname === '/api/practice/look' && req.method === 'POST') {
    const body = await readBody(req);
    Object.assign(live, { look: typeof body.look === 'string' ? body.look : 'idle', card: body.card ?? null, react: body.react ?? null, at: Date.now() });
    return json(res, 200, { ok: true });
  }
  // Your words on a practice call, transcribed locally by whisper.cpp: raw 16 kHz mono int16 PCM in.
  if (url.pathname === '/api/stt' && req.method === 'POST') {
    const parts = []; for await (const c of req) parts.push(c);
    const buf = Buffer.concat(parts);
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
    try { const started = Date.now(); const text = await transcribe(pcm); return json(res, 200, { text, ms: Date.now() - started }); }
    catch (error) { return json(res, 503, { error: `Local transcription failed: ${error.message}` }); }
  }
  if (url.pathname === '/api/practice/chat' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.reset) live.chat = [];
    else if (typeof body.text === 'string') {
      const same = body.id != null && live.chat.find(m => m.id === body.id);
      if (same) same.text = body.text; else live.chat.push({ who: body.who === 'you' ? 'you' : 'claude', text: body.text.slice(0, 600), id: body.id ?? null, at: Date.now() });
      live.chat = live.chat.slice(-8);
    }
    live.chatAt = Date.now() + Math.random();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/tts' && req.method === 'POST') return tts(res, String((await readBody(req)).text ?? '').slice(0, 600));
  json(res, 404, { error: 'not found' });
}

// ---- Practice calls: the real call's prompt and voice, in the browser, with nothing actually run. ----

/** The three kinds of call, with the persona's own lines as the default opener. */
export function practiceScenarios(persona) {
  const l = persona.lines;
  // "Hi!" + "your tests..." reads as two sentences, so the second one needs its capital.
  const after = (opener, rest) => `${opener} ${/[.!?]$/.test(opener) ? rest[0].toUpperCase() + rest.slice(1) : rest}`;
  return {
    approve: { label: 'It asks permission', job: { approval: true }, opener: after(l.opener, `I want to push your login fix to GitHub. ${l.ask}`), facts: 'Claude Code wants to run: git push origin main\nWhy: push the login fix to GitHub (2 commits ahead of origin)', card: { kind: 'approve', title: 'Allow this?', command: 'git push origin main', lines: ['Push the login fix', '2 commits ahead of origin'] }, look: 'waiting' },
    failed: { label: 'Your tests broke', job: { canFix: true }, opener: after(l.opener, `your tests failed in the auth module. ${l.fixAsk}`), facts: 'npm test failed: auth.test.js, 2 failing (expected 200, got 401)', card: { kind: 'error', title: 'Tests failed', lines: ['auth.test.js: 2 failing', 'expected 200, got 401'] }, look: 'error' },
    chat: { label: 'Just say hi', job: { inbound: true }, opener: l.hello, facts: '', card: null, look: 'greeting' },
  };
}

const personaFrom = body => body.persona === 'custom' && String(body.customStyle ?? '').trim()
  ? customPersona(String(body.customStyle).trim().slice(0, 400)) : PERSONAS[body.persona] ?? PERSONAS[config().personality] ?? PERSONAS[DEFAULT_PERSONA];

const TOOLS = {
  approve: { description: 'Let Claude Code go ahead. Use only after a clear yes. Set always to true if they said to always allow this kind of thing.', parameters: { type: 'object', properties: { always: { type: 'boolean' } } } },
  deny: { description: 'Stop Claude Code from doing it. Use when the developer says no or is unsure.', parameters: { type: 'object', properties: { reason: { type: 'string' } } } },
  start_fix: { description: 'Start fixing the problem. Use as soon as the developer says yes.', parameters: { type: 'object', properties: {} } },
  end_call: { description: 'End the call. Use when the developer declines the fix, is done, or says goodbye.', parameters: { type: 'object', properties: {} } },
};

async function practiceStart(body) {
  if (!process.env.OPENAI_API_KEY) throw new Error('No OpenAI key yet: run facetime-me --setup');
  const settings = config(), persona = personaFrom(body);
  const scenario = practiceScenarios(persona)[body.scenario] ?? practiceScenarios(persona).approve;
  const opener = String(body.opener ?? '').trim().slice(0, 400) || scenario.opener;
  const facts = String(body.facts ?? '').trim().slice(0, 1200);
  const job = { ...scenario.job, ...(facts ? { context: facts } : {}) };
  const eleven = Boolean(process.env.ELEVENLABS_API_KEY) && settings.tts !== 'openai';
  const tags = eleven ? tagsFor(settings) : [];
  const names = job.approval ? ['approve', 'deny'] : job.canFix ? ['start_fix', 'end_call'] : ['end_call'];
  const speed = Number(settings.speed) || 1.1;
  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 600 }, session: {
      type: 'realtime', model: 'gpt-realtime', instructions: instructionsFor(job, persona, { tags }),
      ...(eleven ? { output_modalities: ['text'] } : {}),
      audio: {
        input: { transcription: { model: 'gpt-4o-transcribe' }, noise_reduction: { type: 'near_field' }, turn_detection: { type: 'semantic_vad', eagerness: 'high', create_response: true, interrupt_response: true } },
        ...(eleven ? {} : { output: { voice: VOICES.includes(body.voice) ? body.voice : settings.voice ?? persona.voice, speed: Math.min(1.5, Math.max(0.8, speed)) } }),
      },
      tools: names.map(name => ({ type: 'function', name, ...TOOLS[name] })),
    } }),
  });
  const minted = await response.json().catch(() => ({}));
  if (!response.ok || !minted.value) throw new Error(`OpenAI would not start a call (HTTP ${response.status}${minted.error?.message ? `: ${minted.error.message}` : ''})`);
  const l = persona.lines;
  return { secret: minted.value, eleven, tags, stt: whisperOn ? 'whisper' : 'openai', opener, card: scenario.card, look: scenario.look,
    lines: { approved: l.approved, denied: l.denied, bye: l.bye, nudge: l.nudge ?? 'Still there? Let me know.', noAnswer: l.noAnswer ?? 'No answer, so it is waiting in your terminal.', fixed: 'Fixed. All 12 tests pass now.', pushed: 'Done. Your fix is pushed to GitHub.', pushing: 'Pushing to main.', found: 'Found it. A missing await in login.', notHeard: 'Not done: no clear yes in what the developer said. Ask again in one short sentence, in your personality.' } };
}

/** ElevenLabs speech as raw 24 kHz PCM, streamed through as it arrives. Short lines are cached whole. */
const spoken = new Map();
async function tts(res, text) {
  const settings = config();
  if (!text.trim()) return json(res, 400, { error: 'Nothing to say.' });
  if (!process.env.ELEVENLABS_API_KEY) return json(res, 400, { error: 'No ElevenLabs key: run pbpaste | facetime-me --key elevenlabs' });
  const model = settings.elevenModel || 'eleven_flash_v2_5', voiceId = settings.elevenVoice || ELEVEN_DEFAULT;
  const key = `${voiceId}|${model}|${text}`;
  const head = { 'content-type': 'audio/L16; rate=24000', 'cache-control': 'no-store' };
  if (spoken.has(key)) { res.writeHead(200, head); return res.end(spoken.get(key)); }
  const speed = Math.min(1.2, Math.max(0.7, Number(settings.speed) || 1.1));
  const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000${/^eleven_v[3-9]/.test(model) ? '' : '&optimize_streaming_latency=3'}`, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true, speed } }),
  });
  if (!upstream.ok) return json(res, 502, { error: `ElevenLabs could not say that (HTTP ${upstream.status}): ${(await upstream.text()).slice(0, 200)}` });
  res.writeHead(200, head);
  const parts = [];
  for await (const chunk of upstream.body) { parts.push(chunk); res.write(chunk); }
  res.end();
  if (text.length <= 300) { spoken.set(key, Buffer.concat(parts)); if (spoken.size > 200) spoken.delete(spoken.keys().next().value); }
}

export async function preview({ open = true } = {}) {
  loadSecrets();
  frames = loadFrames();
  startWhisper(config()).then(ok => { whisperOn = ok; console.log(ok ? 'facetime-me · local Whisper (whisper.cpp, large-v3-turbo) is transcribing practice calls' : 'facetime-me · whisper.cpp not found, so practice calls use OpenAI transcription. brew install whisper-cpp to switch.'); });
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

// Local speech-to-text with whisper.cpp (github.com/ggml-org/whisper.cpp), large-v3-turbo on the Mac's GPU.
// Setup: `brew install whisper-cpp`, then put ggml-large-v3-turbo-q5_0.bin in ~/.cache/facetime-me/
// (or set config.whisperModel). Without either, callers fall back to OpenAI's transcription.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.FACETIME_ME_WHISPER_PORT) || 4778;
// Context words so "main", "npm" and "GitHub" come out right instead of "Maine".
const PROMPT = 'A developer talking with their coding agent about git, the main branch, GitHub, npm tests and code. Yes. No. Go ahead.';
// What Whisper invents for silence or breath. Dropped unless the clip was clearly loud speech.
const PHANTOMS = /^(you|thank you|thanks|thank you for watching|thanks for watching|\.|\[.*\]|\(.*\))[.!]?$/i;

let proc = null, ready = null;

export function whisperModel(settings = {}) {
  const path = settings.whisperModel || join(homedir(), '.cache', 'facetime-me', 'ggml-large-v3-turbo-q5_0.bin');
  return existsSync(path) ? path : null;
}

const findBinary = () => {
  const found = spawnSync('which', ['whisper-server'], { encoding: 'utf8' }).stdout.trim();
  return found || ['/opt/homebrew/bin/whisper-server', '/usr/local/bin/whisper-server'].find(existsSync) || null;
};

/** Starts whisper-server once and resolves true when it answers, false when it is not installed or fails. */
export function startWhisper(settings = {}) {
  if (ready) return ready;
  const bin = findBinary(), model = whisperModel(settings);
  if (!bin || !model) return (ready = Promise.resolve(false));
  proc = spawn(bin, ['-m', model, '--host', '127.0.0.1', '--port', String(PORT), '-l', 'en', '-nt', '-sns', '-nlp', '--prompt', PROMPT], { stdio: 'ignore' });
  proc.on('exit', () => { proc = null; ready = null; });
  const stop = () => { try { proc?.kill(); } catch {} };
  process.once('exit', stop); process.once('SIGINT', () => { stop(); process.exit(0); }); process.once('SIGTERM', () => { stop(); process.exit(0); });
  ready = (async () => {
    for (let i = 0; i < 100; i++) {
      try { await transcribe(new Int16Array(8000)); return true; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
    return false;
  })();
  return ready;
}

const wav = (pcm, rate) => {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
};

/** 16 kHz mono int16 PCM in, the words out ('' for silence or noise). Throws if whisper-server is not up. */
export async function transcribe(pcm, rate = 16000) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  const rms = Math.sqrt(sum / Math.max(1, pcm.length)) / 32768;
  const form = new FormData();
  form.append('file', new Blob([wav(pcm, rate)], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  form.append('prompt', PROMPT);
  const res = await fetch(`http://127.0.0.1:${PORT}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}`);
  if (rms < 0.004) return ''; // far too quiet to be words
  const out = await res.json();
  const kept = (out.segments ?? [{ text: out.text, avg_logprob: 0, no_speech_prob: 0 }])
    .filter(s => (s.no_speech_prob ?? 0) < 0.6 && (s.avg_logprob ?? 0) > -1.0)
    .map(s => s.text.trim()).filter(Boolean);
  const text = kept.join(' ').replace(/\s+/g, ' ').trim();
  if (PHANTOMS.test(text) && rms < 0.03) return '';
  return text;
}

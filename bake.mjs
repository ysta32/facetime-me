// Decodes the mascot GIFs (unmodified) into native-resolution frames composited on black.
// The pack's GIFs are exact 2x enlargements, so 240x220 loses nothing and 3x gives integer scaling.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buddyFrames } from './buddy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// An optional GIF pack (manifest.json + one GIF per state). Without one, the built-in buddy (buddy.mjs) is used.
const MASCOT = process.env.FACETIME_ME_MASCOT_DIR || join(homedir(), 'mascot');
export const hasPack = () => existsSync(join(MASCOT, 'manifest.json'));
const OUT = join(HERE, 'frames');
export const NATIVE_W = 240, NATIVE_H = 220;
const SRC_W = 480, SRC_H = 440;
export const STATES = ['greeting', 'error-fluid', 'waiting-for-you-fluid', 'thinking-fluid', 'running-commands-fluid', 'done', 'idle-fluid',
  'reading-fluid', 'writing-fluid', 'searching-code-fluid', 'searching-web-fluid', 'testing-fluid', 'committing-fluid',
  'directing-helpers-fluid', 'plan-progress-fluid', 'using-tool-fluid'];

function bake(name, manifest) {
  const file = join(MASCOT, `${name}.gif`);
  const entry = manifest.states.find(s => s.name === name);
  if (!entry) throw new Error(`${name} is not in manifest.json`);
  const ptsText = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const pts = ptsText.trim().split('\n').map(line => Math.round(parseFloat(line) * 1000));
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 });
  const count = raw.length / (SRC_W * SRC_H * 4);
  if (!Number.isInteger(count) || count !== pts.length) throw new Error(`${name}: decoded ${count} frames, timestamps say ${pts.length}`);
  const out = Buffer.alloc(count * NATIVE_W * NATIVE_H * 4);
  for (let f = 0; f < count; f++) {
    const srcBase = f * SRC_W * SRC_H * 4, dstBase = f * NATIVE_W * NATIVE_H * 4;
    for (let y = 0; y < NATIVE_H; y++) for (let x = 0; x < NATIVE_W; x++) {
      const s = srcBase + ((y * 2) * SRC_W + x * 2) * 4, d = dstBase + (y * NATIVE_W + x) * 4;
      // Keep real transparency (the pack is hard-edged pixel art) so the mascot can sit on the scene.
      const opaque = raw[s + 3] > 127;
      out[d] = opaque ? raw[s] : 0; out[d + 1] = opaque ? raw[s + 1] : 0; out[d + 2] = opaque ? raw[s + 2] : 0; out[d + 3] = opaque ? 255 : 0;
    }
  }
  writeFileSync(join(OUT, `${name}.rgba`), out);
  return { name, frames: count, startsMs: pts, durationMs: entry.durationMs, loop: entry.loop, alpha: true };
}

export function bakeAll() {
  mkdirSync(OUT, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(MASCOT, 'manifest.json'), 'utf8'));
  const index = STATES.map(name => bake(name, manifest));
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));
  return index;
}

export function loadFrames() {
  if (process.env.FACETIME_ME_MASCOT === 'buddy') return buddyFrames(STATES);
  const indexPath = join(OUT, 'index.json');
  let index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : [];
  // Rebake when a look was added since the last bake.
  if (!STATES.every(name => index.some(entry => entry.name === name && entry.alpha && existsSync(join(OUT, `${name}.rgba`))))) {
    if (!hasPack()) return buddyFrames(STATES);
    index = bakeAll();
  }
  return Object.fromEntries(index.map(entry => [entry.name, { ...entry, data: readFileSync(join(OUT, `${entry.name}.rgba`)) }]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(bakeAll().map(s => `${s.name}: ${s.frames} frames, ${s.durationMs}ms, loop=${s.loop}`).join('\n'));

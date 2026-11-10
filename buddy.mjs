// The built-in mascot: an original pixel "phone buddy", drawn in code so the repo ships no third-party art.
// Every look the call uses gets its own short animation, in the same clip format bake.mjs produces
// (240x220 RGBA frames, hard-edged alpha), so it drops in wherever a baked GIF pack would.
export const NATIVE_W = 240, NATIVE_H = 220;
const CELL = 4, COLS = NATIVE_W / CELL, ROWS = NATIVE_H / CELL; // a 60x55 pixel grid

const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C = {
  ink: hex('#17202c'), body: hex('#5ec2b7'), shade: hex('#3f9c93'), light: hex('#a6ebe2'),
  screen: hex('#122030'), screenRed: hex('#4a1820'), screenGreen: hex('#123a2a'),
  eye: hex('#eafff9'), red: hex('#ff6b6b'), gold: hex('#ffd166'), green: hex('#7ee08a'),
};

class Canvas {
  constructor() { this.px = Buffer.alloc(NATIVE_W * NATIVE_H * 4); }
  dot(x, y, color) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return;
    for (let dy = 0; dy < CELL; dy++) for (let dx = 0; dx < CELL; dx++) {
      const i = ((y * CELL + dy) * NATIVE_W + x * CELL + dx) * 4;
      this.px[i] = color[0]; this.px[i + 1] = color[1]; this.px[i + 2] = color[2]; this.px[i + 3] = 255;
    }
  }
  rect(x, y, w, h, color) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.dot(x + i, y + j, color); }
  /** Draws rows of a tiny bitmap, '#' = on. */
  glyph(x, y, rows, color) { rows.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === '#') this.dot(x + i, y + j, color); })); }
}

const GLYPH = {
  q: ['.###.', '#...#', '...#.', '..#..', '.....', '..#..'],
  check: ['....#', '...#.', '#.#..', '.#...'],
  up: ['..#..', '.###.', '#.#.#', '..#..', '..#..'],
  cursor: ['#....', '.#...', '#..##'],
  x: ['#.#', '.#.', '#.#'],
  happy: ['.#.', '#.#'],
};

/**
 * One frame of the buddy. `o` tweaks the pose:
 * dx/dy body offset, look = [ex, ey] eye shift, eyes = 'open'|'shut'|'x'|'happy', screen colour,
 * arm = 'down'|'up'|'out' for the right arm, leftArm likewise, and extra = a function for props.
 */
function frame(o = {}) {
  const c = new Canvas();
  const x0 = 18 + (o.dx ?? 0), y0 = 12 + (o.dy ?? 0);
  const W = 24, H = 32;
  // Shadow on the ground stays put while the body moves.
  c.rect(20, 51, 20, 1, C.ink);
  // Legs.
  const legH = Math.max(1, 5 - Math.max(0, -(o.dy ?? 0)));
  c.rect(x0 + 6, y0 + H, 3, legH, C.ink); c.rect(x0 + 15, y0 + H, 3, legH, C.ink);
  // Arms, behind the body edge.
  const arm = (side, pose) => {
    const ax = side < 0 ? x0 - 3 : x0 + W;
    if (pose === 'up') { c.rect(ax, y0 + 8, 3, 3, C.ink); c.rect(ax + (side < 0 ? 0 : 1), y0 + 3, 2, 6, C.ink); c.rect(ax + (side < 0 ? 0 : 1), y0 + 3, 2, 2, C.body); }
    else if (pose === 'out') c.rect(ax, y0 + 14, 3, 3, C.ink);
    else { c.rect(ax + (side < 0 ? 1 : 0), y0 + 14, 2, 6, C.ink); }
  };
  arm(-1, o.leftArm ?? 'down');
  arm(1, o.arm ?? 'down');
  // Body: a rounded handset with an outline, a highlight and a shaded right edge.
  c.rect(x0 + 1, y0, W - 2, H, C.ink); c.rect(x0, y0 + 1, W, H - 2, C.ink);
  c.rect(x0 + 2, y0 + 1, W - 4, H - 2, C.body); c.rect(x0 + 1, y0 + 2, W - 2, H - 4, C.body);
  c.rect(x0 + W - 3, y0 + 3, 2, H - 6, C.shade);
  c.rect(x0 + 3, y0 + 2, 6, 1, C.light); c.rect(x0 + 2, y0 + 3, 1, 4, C.light);
  // Speaker slot and home button.
  c.rect(x0 + 9, y0 + 2, 6, 1, C.ink);
  c.rect(x0 + 10, y0 + H - 4, 4, 2, C.shade);
  // Screen with the face.
  const sx = x0 + 3, sy = y0 + 4, SW = W - 6, SH = H - 10;
  c.rect(sx, sy, SW, SH, C[o.screen ?? 'screen']);
  const [ex, ey] = o.look ?? [0, 0];
  const eyeY = sy + 7 + ey, lx = sx + 5 + ex, rx = sx + 12 + ex;
  const eyes = o.eyes ?? 'open';
  if (eyes === 'open') { c.rect(lx, eyeY, 2, 3, C.eye); c.rect(rx, eyeY, 2, 3, C.eye); }
  else if (eyes === 'shut') { c.rect(lx, eyeY + 2, 2, 1, C.eye); c.rect(rx, eyeY + 2, 2, 1, C.eye); }
  else if (eyes === 'x') { c.glyph(lx - 1, eyeY, GLYPH.x, C.red); c.glyph(rx - 1, eyeY, GLYPH.x, C.red); }
  else if (eyes === 'happy') { c.glyph(lx - 1, eyeY + 1, GLYPH.happy, C.eye); c.glyph(rx - 1, eyeY + 1, GLYPH.happy, C.eye); }
  if (o.mouth !== false) {
    const my = sy + 13 + ey;
    if (o.mouth === 'open') c.rect(sx + 8 + ex, my, 3, 2, C.eye);
    else if (o.mouth === 'frown') { c.rect(sx + 8 + ex, my, 3, 1, C.eye); c.dot(sx + 7 + ex, my + 1, C.eye); c.dot(sx + 11 + ex, my + 1, C.eye); }
    else { c.dot(sx + 7 + ex, my, C.eye); c.rect(sx + 8 + ex, my + 1, 3, 1, C.eye); c.dot(sx + 11 + ex, my, C.eye); }
  }
  o.extra?.(c, { x0, y0, sx, sy, SW, SH });
  return c.px;
}

const BLINK = { eyes: 'shut' };
/** Builds a clip from [pose, ms] steps. */
function clip(name, steps, loop = true) {
  const startsMs = []; let t = 0;
  for (const [, ms] of steps) { startsMs.push(t); t += ms; }
  return { name, frames: steps.length, startsMs, durationMs: t, loop, alpha: true, data: Buffer.concat(steps.map(([pose]) => frame(pose))) };
}

const dots = n => (c, { x0, y0 }) => { for (let i = 0; i < n; i++) c.rect(x0 + 6 + i * 5, y0 - 6, 2, 2, C.gold); };
const above = (g, color, lift = 0) => (c, { x0, y0 }) => c.glyph(x0 + 10, y0 - 9 - lift, g, color);
const onScreen = (g, color) => (c, { sx, sy, SH }) => c.glyph(sx + 2, sy + SH - 5, g, color);
const both = (...fns) => (c, box) => fns.forEach(fn => fn?.(c, box));

const CLIPS = {
  'idle-fluid': () => clip('idle-fluid', [[{}, 700], [{ dy: 1 }, 500], [{}, 700], [{ dy: 1 }, 500], [{ dy: 1, ...BLINK }, 140], [{}, 700]]),
  greeting: () => clip('greeting', [[{ arm: 'up', mouth: 'open' }, 260], [{ arm: 'out', mouth: 'open' }, 220], [{ arm: 'up', mouth: 'open' }, 260], [{ arm: 'out' }, 220], [{ arm: 'up', mouth: 'open' }, 260], [{}, 600]], false),
  'thinking-fluid': () => clip('thinking-fluid', [[{ look: [1, -1], extra: dots(1) }, 380], [{ look: [1, -1], extra: dots(2) }, 380], [{ look: [1, -1], extra: dots(3), mouth: false }, 380], [{ look: [1, -1], dy: 1, extra: dots(3) }, 300], [{ ...BLINK, look: [1, -1] }, 120]]),
  'waiting-for-you-fluid': () => clip('waiting-for-you-fluid', [[{ extra: above(GLYPH.q, C.gold) }, 600], [{ extra: above(GLYPH.q, C.gold, 1), dy: 1 }, 500], [{ extra: above(GLYPH.q, C.gold) }, 600], [{ ...BLINK, extra: above(GLYPH.q, C.gold) }, 140], [{}, 400]]),
  'error-fluid': () => clip('error-fluid', [[{ screen: 'screenRed', eyes: 'x', mouth: 'frown' }, 160], [{ screen: 'screenRed', eyes: 'x', mouth: 'frown', dx: -1 }, 80], [{ screen: 'screenRed', eyes: 'x', mouth: 'frown', dx: 1 }, 80], [{ screen: 'screenRed', eyes: 'x', mouth: 'frown', dx: -1 }, 80], [{ screen: 'screenRed', eyes: 'x', mouth: 'frown' }, 900], [{ screen: 'screenRed', mouth: 'frown', look: [0, 1] }, 700]]),
  done: () => clip('done', [[{ eyes: 'happy' }, 200], [{ eyes: 'happy', dy: -3, arm: 'up', leftArm: 'up', mouth: 'open' }, 260], [{ eyes: 'happy', dy: -1, arm: 'up', leftArm: 'up' }, 160], [{ eyes: 'happy', screen: 'screenGreen' }, 900]], false),
  'running-commands-fluid': () => clip('running-commands-fluid', [[{ look: [0, -1], mouth: false, extra: onScreen(GLYPH.cursor, C.green) }, 400], [{ look: [0, -1], mouth: false, extra: onScreen(GLYPH.cursor.slice(0, 2), C.green) }, 400]]),
  'reading-fluid': () => clip('reading-fluid', [[{ look: [-2, 1] }, 420], [{ look: [0, 1] }, 420], [{ look: [2, 1] }, 420], [{ look: [-2, 2] }, 300], [{ ...BLINK, look: [0, 1] }, 120]]),
  'writing-fluid': () => clip('writing-fluid', [[{ look: [1, 2], arm: 'out' }, 200], [{ look: [1, 2], arm: 'down' }, 200], [{ look: [1, 2], arm: 'out' }, 200], [{ look: [1, 2], arm: 'down', dy: 1 }, 260]]),
  'searching-code-fluid': () => clip('searching-code-fluid', [[{ look: [-2, 0] }, 360], [{ look: [2, 0] }, 360], [{ look: [-2, 1] }, 360], [{ look: [2, 1], dy: 1 }, 360]]),
  'searching-web-fluid': () => clip('searching-web-fluid', [[{ look: [-2, -1], arm: 'out' }, 380], [{ look: [2, -1], arm: 'out' }, 380], [{ look: [0, -1], dy: 1 }, 300]]),
  'testing-fluid': () => clip('testing-fluid', [[{ look: [0, 1], extra: onScreen(GLYPH.check, C.green) }, 450], [{ look: [0, 1] }, 250], [{ look: [0, 1], extra: onScreen(GLYPH.check, C.green), dy: 1 }, 450]]),
  'committing-fluid': () => clip('committing-fluid', [[{ arm: 'up', extra: above(GLYPH.up, C.green) }, 300], [{ arm: 'up', extra: above(GLYPH.up, C.green, 2) }, 300], [{ extra: above(GLYPH.up, C.green, 4) }, 300], [{ dy: 1 }, 200]]),
  'directing-helpers-fluid': () => clip('directing-helpers-fluid', [[{ arm: 'out', look: [2, 0] }, 400], [{ leftArm: 'out', look: [-2, 0] }, 400]]),
  'plan-progress-fluid': () => clip('plan-progress-fluid', [[{ look: [0, -1], extra: dots(1) }, 300], [{ look: [0, -1], extra: dots(2) }, 300], [{ look: [0, -1], extra: dots(3) }, 300], [{ eyes: 'happy' }, 400]]),
  'using-tool-fluid': () => clip('using-tool-fluid', [[{ arm: 'out', look: [1, 1] }, 260], [{ arm: 'up', look: [1, 0] }, 260], [{ arm: 'out', look: [1, 1], dy: 1 }, 260]]),
};

/** Clips for every requested state, in bake.mjs's format. */
export function buddyFrames(states) {
  return Object.fromEntries(states.map(name => [name, (CLIPS[name] ?? CLIPS['idle-fluid'])()]).map(([name, value]) => [name, { ...value, name }]));
}

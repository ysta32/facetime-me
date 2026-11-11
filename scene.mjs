// The call's camera picture, drawn on the mascot's own pixel grid (1 grid pixel = 4 screen pixels):
// a dithered dusk sky, the mascot standing on a horizon, and a paper "work card" above its head that
// shows what Claude is doing right now, using the real file, command, search and test results.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 240x427 grid at 3x = the 720x1280 frame. iPhones fill the screen and cut ~9% off each side, so
// everything that matters stays inside SAFE (the centre 80%).
export const GRID = 3, LW = 240, LH = 427;
export const SAFE = { left: 30, right: LW - 30 };

const hex = h => { const n = parseInt(h.slice(1), 16); return (0xff000000 | ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16)) >>> 0; };
const C = {
  paper: hex('#F2EBDF'), ink: hex('#22305A'), dim: hex('#7D8199'), bar: hex('#D3CABA'), bar2: hex('#B9C0D8'),
  orange: hex('#E88C40'), orangeSoft: hex('#F7D3AE'), green: hex('#2E8B57'), red: hex('#B8433B'),
};
/** Backgrounds. sky/ground are dithered top-to-bottom; decor is what drifts or twinkles in the sky. */
export const THEMES = {
  night: { name: 'Night sky', sky: ['#111731', '#161E3B', '#1C2647', '#232F56', '#2B3A66'], ground: ['#18203D', '#141A33', '#10152A'], horizon: '#3A4878', shadow: '#0B1026', decor: 'stars', star: ['#33406C', '#6874A3', '#C3CCEB'], footer: '#56638F', cardShadow: '#0A0E22' },
  dawn: { name: 'Sunrise', sky: ['#6E5A9C', '#9A6FA6', '#C987A4', '#EBA59B', '#F6C79A'], ground: ['#7A4F6E', '#663F5E', '#53334F'], horizon: '#F9DDA8', shadow: '#3F2640', decor: 'sun', star: ['#F6C79A', '#FBE3B8', '#FFF6DE'], footer: '#F9DDA8', cardShadow: '#3F2640' },
  daylight: { name: 'Blue sky', sky: ['#5DA9E9', '#6FB5EC', '#84C1EF', '#9CCEF2', '#B6DBF5'], ground: ['#79B866', '#6AA85A', '#5B984E'], horizon: '#A6D68C', shadow: '#4C8442', decor: 'clouds', star: ['#DCEBFA', '#F1F7FD', '#FFFFFF'], footer: '#2F5F8F', cardShadow: '#3B78AE' },
  mint: { name: 'Mint', sky: ['#BFE8D9', '#C9ECDF', '#D3F0E5', '#DDF3EA', '#E7F7F0'], ground: ['#F3E5CF', '#EADAC1', '#E0CEB3'], horizon: '#9BD3BE', shadow: '#CDB797', decor: 'sparkles', star: ['#9BD3BE', '#F2A7B8', '#FFFFFF'], footer: '#5F8F7E', cardShadow: '#8FBFAE' },
  terminal: { name: 'Terminal', sky: ['#0F1A14', '#112019', '#13251C', '#152A20', '#173024'], ground: ['#0D1611', '#0B130F', '#09100C'], horizon: '#2F7A4E', shadow: '#050906', decor: 'grid', star: ['#1D3F2C', '#2F7A4E', '#7BE0A4'], footer: '#3F9A66', cardShadow: '#050906' },
  peach: { name: 'Peach room', sky: ['#F6D5C3', '#F4CDB9', '#F1C4AE', '#EEBCA4', '#EBB39A'], ground: ['#C98F72', '#BC8266', '#AE765B'], horizon: '#E3A587', shadow: '#9A6650', decor: 'none', star: ['#F9E3D6', '#FCEEE6', '#FFFFFF'], footer: '#8E5A44', cardShadow: '#B97F64' },
};
const palette = id => { const t = THEMES[id] ?? THEMES.night; return { ...t, sky: t.sky.map(hex), ground: t.ground.map(hex), star: t.star.map(hex), horizon: hex(t.horizon), shadow: hex(t.shadow), footer: hex(t.footer), cardShadow: hex(t.cardShadow) }; };
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);

const FONT = JSON.parse(readFileSync(join(HERE, 'font.json'), 'utf8'));
const FW = FONT.w, FH = FONT.h, LINE = 12;

// 7x7 icons, one per kind of work.
const ICON = {
  reading: ['0111110', '0100010', '0111110', '0100010', '0111110', '0100010', '0111110'],
  writing: ['0000011', '0000111', '0001110', '0011100', '0111000', '1110000', '1100000'],
  search: ['0111000', '1000100', '1000100', '1000100', '0111100', '0000110', '0000011'],
  web: ['0011100', '0101010', '1111111', '1001001', '1111111', '0101010', '0011100'],
  running: ['1000000', '0100000', '0010000', '0100000', '1000000', '0000000', '0001111'],
  testing: ['0011100', '0001000', '0001000', '0010100', '0100010', '1111111', '0111110'],
  committing: ['0001000', '0001000', '0011100', '1110111', '0011100', '0001000', '0001000'],
  planning: ['1101111', '0000000', '1101111', '0000000', '1101111', '0000000', '1101111'],
  helpers: ['0100010', '1110111', '0100010', '0000000', '0100010', '1110111', '0100010'],
  tool: ['0001110', '0010001', '0001101', '0011110', '0111000', '1110000', '1100000'],
  thinking: ['0000000', '0000000', '0000000', '1101011', '1101011', '0000000', '0000000'],
  error: ['0011100', '0011100', '0011100', '0011100', '0000000', '0011100', '0011100'],
  waiting: ['0111100', '1100110', '0000110', '0001100', '0011000', '0000000', '0011000'],
  done: ['0000001', '0000011', '0000110', '1001100', '1111000', '0110000', '0000000'],
};

const firstLine = (text, n = 1) => String(text ?? '').split('\n').map(l => l.replace(/\t/g, '  ').trim()).filter(Boolean).slice(0, n);
const lastLines = (text, n) => String(text ?? '').split('\n').map(l => l.replace(/\t/g, '  ').replace(/\x1b\[[0-9;]*m/g, '').trimEnd()).filter(l => l.trim()).slice(-n);
/** Word-wraps to the card width so summaries are never cut mid-word. */
const wrap = (lines, width) => lines.flatMap(line => { const out = []; let cur = ''; for (const word of String(line).split(/\s+/)) { if (cur && (cur + ' ' + word).length > width) { out.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word; } if (cur) out.push(cur); return out; });
/** The pixel font is ASCII: map the symbols test runners and terminals print to plain stand-ins. */
const SYMBOLS = { '✖': 'x', '✗': 'x', '×': 'x', '✓': 'v', '✔': 'v', '…': '..', '→': '->', 'ℹ': 'i', '‘': "'", '’': "'", '“': '"', '”': '"', '—': '-', '–': '-', '•': '*', '▶': '>' };
const asciiOnly = str => [...String(str)].map(ch => SYMBOLS[ch] ?? (ch >= ' ' && ch <= '~' ? ch : '?')).join('');
/** What a person would type: drops output plumbing like `2>&1 | tail -15`. */
const cleanCommand = cmd => (firstLine(cmd)[0] ?? '').replace(/\s*\|\s*(tail|head|grep|less|cat)\b.*$/, '').replace(/\s+[12]?>&?[12]?(\s*\/dev\/null)?/g, '').trim();
const shortPath = p => { const parts = String(p ?? '').split('/').filter(Boolean); return parts.slice(-2).join('/'); };
const rng = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

/** Counts from common test runners' output: node:test, jest/vitest, pytest, go, cargo. */
export function testCounts(output) {
  const text = String(output ?? '');
  const num = re => { const m = text.match(re); return m ? Number(m[1]) : null; };
  let pass = num(/ℹ pass (\d+)/) ?? num(/(\d+) passed/) ?? num(/# pass (\d+)/) ?? num(/test result: ok\. (\d+) passed/);
  let fail = num(/ℹ fail (\d+)/) ?? num(/(\d+) failed/) ?? num(/# fail (\d+)/) ?? 0;
  if (pass == null) { const ok = (text.match(/^(ok|--- PASS)/gm) ?? []).length, bad = (text.match(/^(not ok|--- FAIL)/gm) ?? []).length; if (ok + bad) { pass = ok; fail = bad; } }
  return pass == null ? null : { pass, fail };
}

/** What the card says for each kind of work: a title, an icon and how many body rows it needs. */
function describe(card) {
  const input = card.input ?? {}, cmd = String(input.command ?? '');
  switch (card.kind) {
    case 'reading': return { title: 'Reading', icon: 'reading', rows: 4 };
    case 'writing': return { title: input.command ? 'Editing from the shell' : input.content != null && input.old_string == null ? 'Writing a file' : 'Editing', icon: 'writing', rows: input.command ? 2 : 1 + (input.old_string ? 1 : 0) + Math.min(2, firstLine(input.new_string ?? input.new_source ?? input.content, 2).length) };
    case 'searchingCode': return { title: 'Searching the code', icon: 'search', rows: 4 };
    case 'searchingWeb': return { title: 'Looking it up', icon: 'web', rows: 4 };
    case 'running': return { title: 'Running a command', icon: 'running', rows: 4 };
    case 'testing': return { title: 'Running the tests', icon: 'testing', rows: 3 };
    case 'committing': return { title: 'Committing', icon: 'committing', rows: 3 };
    case 'planning': return { title: 'Planning', icon: 'planning', rows: Math.min(4, Math.max(1, (input.todos ?? []).length)) };
    case 'helpers': return { title: 'Handing off to a helper', icon: 'helpers', rows: 2 };
    case 'usingTool': return { title: 'Using a tool', icon: 'tool', rows: 1 };
    case 'thinking': return { title: card.title ?? 'Thinking', icon: 'thinking', rows: 1 };
    case 'error': return { title: card.title ?? 'Something broke', icon: 'error', rows: Math.min(4, 1 + (card.lines?.length ?? 0)) };
    case 'approve': return { title: card.title ?? 'Allow this?', icon: 'waiting', rows: Math.min(4, (card.command ? 1 : 0) + (card.lines?.length ?? 0)) || 1 };
    case 'waiting': return { title: card.title ?? 'Want me to fix it?', icon: 'waiting', rows: card.buttons === false ? 1 : 2 };
    case 'done': return { title: card.title ?? 'Fixed', icon: 'done', rows: Math.min(4, wrap((card.lines ?? []).map(l => String(l).replace(/`/g, '')), 24).length + (card.tests ? 1 : 0)) || 1 };
    default: return { title: cmd || card.kind, icon: 'tool', rows: 1 };
  }
}

export class Scene {
  /** body: the mascot's opaque bounding box at native size, used to stand it on the horizon. */
  constructor({ body, theme }) {
    this.T = palette(theme);
    this.px = new Uint32Array(LW * LH);
    this.out = new Uint8Array(720 * 1280 * 4);
    this.out32 = new Uint32Array(this.out.buffer);
    this.bodyX = Math.round(LW / 2 - (body.left + body.right + 1) / 2);
    this.feet = 330;
    this.bodyY = this.feet - body.bottom - 1;
    this.headTop = this.bodyY + body.top;
    this.horizon = this.feet + 1;
    this.bodyBox = body;
    this.bg = this.buildBackground(body);
    const r = rng(7);
    this.stars = Array.from({ length: 18 }, () => ({ x: 6 + Math.floor(r() * (LW - 12)), y: 4 + Math.floor(r() * (this.horizon - 60)), period: 2400 + r() * 3600, phase: r() * 6.28, big: r() > 0.75 }));
    this.clouds = Array.from({ length: 4 }, (_, i) => ({ x: r() * LW, y: 20 + i * 52 + Math.floor(r() * 20), w: 22 + Math.floor(r() * 18), speed: 0.0015 + r() * 0.002 }));
    this.card = null;
    this.footer = '';
  }

  setTheme(theme) { this.T = palette(theme); this.bg = this.buildBackground(this.bodyBox); }

  buildBackground(body) {
    const T = this.T;
    const bg = new Uint32Array(LW * LH);
    for (let y = 0; y < LH; y++) for (let x = 0; x < LW; x++) {
      const steps = y <= this.horizon ? T.sky : T.ground;
      const t = y <= this.horizon ? y / this.horizon : (y - this.horizon) / (LH - this.horizon);
      const f = t * (steps.length - 1), lo = Math.floor(f);
      const pick = f - lo > BAYER[(y & 3) * 4 + (x & 3)] ? Math.min(lo + 1, steps.length - 1) : lo;
      bg[y * LW + x] = steps[pick];
    }
    for (let x = 0; x < LW; x++) bg[this.horizon * LW + x] = T.horizon;
    if (T.decor === 'sun') {
      const sx = LW / 2 + 52, sy = this.horizon - 14, sr = 26;
      for (let y = sy - sr; y < this.horizon; y++) for (let x = sx - sr; x <= sx + sr; x++) {
        const d = ((x - sx) ** 2 + (y - sy) ** 2) / sr ** 2;
        if (d <= 1 && (y % 5 !== 0 || y < sy - 8)) bg[y * LW + x] = d < 0.7 ? T.star[2] : T.star[1];
      }
    }
    if (T.decor === 'grid') {
      for (const d of [3, 7, 12, 19, 28, 40, 55, 74]) if (this.horizon + d < LH) for (let x = 0; x < LW; x++) bg[(this.horizon + d) * LW + x] = T.star[0];
      for (let i = -12; i <= 12; i++) for (let y = this.horizon + 1; y < LH; y++) { const x = Math.round(LW / 2 + i * 6 * (y - this.horizon) / 8); if (x >= 0 && x < LW) bg[y * LW + x] = T.star[0]; }
      for (let y = 0; y < this.horizon; y += 3) for (let x = 0; x < LW; x++) if (((x + y) & 7) === 0) bg[y * LW + x] = T.star[0];
    }
    // A soft dithered shadow where the mascot stands.
    const cx = LW / 2, cy = this.feet + 2, rx = (body.right - body.left) / 2 + 10, ry = 4;
    for (let y = cy - ry; y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d <= 0.55 || (d <= 1 && ((x + y) & 1) === 0)) bg[y * LW + x] = T.shadow;
    }
    return bg;
  }

  set(card) { this.card = card ? { ...card, since: null } : null; }

  update(patch) { if (this.card) Object.assign(this.card, patch); }

  // ---- drawing primitives on the grid ----
  dot(x, y, c) { if (x >= 0 && y >= 0 && x < LW && y < LH && y < this.clipY) this.px[y * LW + x] = c; }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.dot(x + i, y + j, c); }
  icon(name, x, y, c) { ICON[name].forEach((row, j) => [...row].forEach((bit, i) => bit === '1' && this.dot(x + i, y + j, c))); }
  text(str, x, y, c, maxChars = 31) {
    let s = asciiOnly(str);
    if (s.length > maxChars) s = `${s.slice(0, maxChars - 2)}..`;
    [...s].forEach((ch, k) => {
      const g = FONT.glyphs[ch] ?? FONT.glyphs['?'];
      for (let j = 0; j < FH; j++) for (let i = 0; i < FW; i++) if (g[j][i] === '1') this.dot(x + k * FW + i, y + j - 2, c);
    });
    return s.length;
  }
  bars(x, y, seed, width, colors) {
    const r = rng(seed * 2654435761);
    let at = x + Math.floor(r() * 3) * 6;
    while (at < x + width - 8) { const w = 6 + Math.floor(r() * 26); if (at + w > x + width) break; this.rect(at, y + 2, w, 3, colors[Math.floor(r() * colors.length)]); at += w + 4; }
  }

  // ---- the work card ----
  drawCard(now) {
    const card = this.card;
    if (!card) return;
    card.since ??= now;
    const t = now - card.since, info = describe(card);
    const x0 = SAFE.left, w = SAFE.right - SAFE.left, y0 = 40, h = 8 + LINE + 4 + info.rows * LINE + 6;
    // Each new card wipes in from the top over 160 ms: the one bit of motion that says "something changed".
    this.clipY = y0 + Math.ceil((h + 8) * Math.min(1, t / 160));
    this.rect(x0 + 2, y0 + 2, w, h, this.T.cardShadow);
    this.rect(x0, y0, w, h, C.paper);
    for (let i = 1; i < w - 1; i++) { this.dot(x0 + i, y0, C.ink); this.dot(x0 + i, y0 + h - 1, C.ink); }
    for (let j = 1; j < h - 1; j++) { this.dot(x0, y0 + j, C.ink); this.dot(x0 + w - 1, y0 + j, C.ink); }
    const tx = x0 + 8;
    this.icon(info.icon, tx, y0 + 7, card.kind === 'error' ? C.red : card.kind === 'done' ? C.green : C.ink);
    this.text(info.title, tx + 12, y0 + 7, C.ink, 28);
    // A thin rule under the title, in orange while work is live.
    const live = !['error', 'waiting', 'done'].includes(card.kind);
    for (let i = 4; i < w - 4; i++) this.dot(x0 + i, y0 + 8 + LINE, live && (i + Math.floor(t / 60)) % 8 < 4 ? C.orange : C.bar);
    const by = y0 + 8 + LINE + 5;
    this.body(card, t, tx, by, w - 16);
    this.clipY = LH;
    // Thought dots from the card down to the mascot's head.
    const bottom = y0 + h + 2, gap = Math.max(0, this.headTop - 30 - bottom), mid = LW / 2;
    [[mid + 26, bottom + 4, 4], [mid + 20, bottom + 6 + gap * 0.45 + 2, 3], [mid + 15, bottom + 8 + gap * 0.85 + 3, 2]].forEach(([dx, dy, s]) => this.rect(dx, Math.round(dy), s, s, C.paper));
  }

  body(card, t, x, y, width) {
    const input = card.input ?? {}, out = card.output, chars = Math.floor(width / FW);
    const row = n => y + n * LINE;
    const typed = (s, cps = 34) => String(s).slice(0, Math.floor(t / 1000 * cps));
    const blink = Math.floor(t / 420) % 2 === 0;
    const cursor = (cx, cy) => blink && this.rect(cx + 1, cy - 2, 4, 8, C.orange);
    const command = (cmd, at) => { cmd = cleanCommand(cmd); const s = typed(`$ ${cmd}`); const n = this.text(s, x, at, C.ink, chars); if (n < Math.min(chars, 2 + String(cmd).length)) cursor(x + n * FW, at); };
    switch (card.kind) {
      case 'reading': {
        this.text(shortPath(input.file_path ?? input.notebook_path ?? input.command), x, row(0), C.dim, chars);
        const scroll = Math.floor(t / 380);
        for (let k = 1; k < 4; k++) this.bars(x + 8, row(k), scroll + k, width - 8, k === 2 ? [C.ink, C.bar2] : [C.bar, C.bar2]);
        this.rect(x, row(2) + 2, 4, 3, C.orange);
        break;
      }
      case 'writing': {
        if (input.command) { command(input.command, row(0)); this.text(firstLine(out, 1)[0] ?? '', x, row(1), C.dim, chars); break; }
        this.text(shortPath(input.file_path ?? input.notebook_path), x, row(0), C.dim, chars);
        let before = firstLine(input.old_string, 1), after = firstLine(input.new_string ?? input.new_source ?? input.content, 2);
        // Long lines would hide the change behind "..": start both just before where they differ.
        if (before.length && after.length && Math.max(before[0].length, after[0].length) > chars - 2) {
          let same = 0; while (same < before[0].length && before[0][same] === after[0][same]) same++;
          const from = Math.max(0, Math.min(same - 10, before[0].length - (chars - 4)));
          if (from > 0) { before = [`..${before[0].slice(from)}`]; after = [`..${after[0].slice(from)}`, ...after.slice(1)]; }
        }
        let r = 1;
        if (before.length) { this.text(`- ${before[0]}`, x, row(r++), C.red, chars); }
        let left = Math.floor(t / 1000 * 30);
        for (const line of after) {
          if (r > 3) break;
          const s = `+ ${line}`.slice(0, Math.max(0, left)); left -= s.length;
          const n = this.text(s, x, row(r), C.green, chars);
          if (left <= 0 || r === 3) { cursor(x + Math.min(n, chars) * FW, row(r)); break; }
          r++;
        }
        break;
      }
      case 'searchingCode': case 'searchingWeb': {
        const grepped = String(input.command ?? '').match(/\b(?:grep|rg|ag)\b(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
        const query = input.pattern ?? input.query ?? input.url ?? (grepped ? grepped[1] ?? grepped[2] ?? grepped[3] : input.command ? firstLine(input.command)[0] : '');
        this.text(card.kind === 'searchingWeb' ? query : `"${query}"`, x, row(0), C.ink, chars);
        const hit = 1 + (Math.floor(t / 450) % 3);
        for (let k = 1; k < 4; k++) {
          if (k === hit) this.rect(x - 2, row(k), width + 4, 7, C.orangeSoft);
          this.bars(x + 4, row(k), k * 13 + 5, width - 18, k === hit ? [C.ink, C.dim] : [C.bar, C.bar2]);
        }
        this.icon('search', x + width - 9, row(hit), C.ink);
        break;
      }
      case 'running': {
        command(input.command, row(0));
        if (out != null) lastLines(out, 3).forEach((line, k) => this.text(line, x, row(k + 1), C.dim, chars));
        else this.rect(x + ((Math.floor(t / 160) % 6) * FW), row(1) + 2, 4, 3, C.bar2);
        break;
      }
      case 'testing': {
        command(input.command, row(0));
        const counts = card.tests ?? (out != null ? testCounts(out) : null);
        const total = counts ? Math.min(Math.floor(width / 8), counts.pass + counts.fail) : 12, step = 8;
        for (let k = 0; k < total; k++) {
          let c = C.bar;
          if (counts) { const shown = Math.floor(t / 70); if (k < shown || card.since < 0) c = k < counts.pass ? C.green : C.red; }
          else if (k === Math.floor(t / 110) % total) c = C.orange;
          this.rect(x + k * step, row(1) + 1, 5, 5, c);
        }
        if (counts) this.text(`${counts.pass} passing${counts.fail ? `, ${counts.fail} failing` : ''}`, x, row(2), counts.fail ? C.red : C.green, chars);
        else if (out != null) this.text(lastLines(out, 1)[0] ?? 'done', x, row(2), C.dim, chars);
        break;
      }
      case 'committing': {
        command(input.command, row(0));
        const n = 4 + Math.min(1, Math.floor(t / 900));
        for (let k = 0; k < n; k++) { this.rect(x + k * 18, row(1) + 1, 5, 5, k === n - 1 ? C.orange : C.ink); if (k) this.rect(x + k * 18 - 13, row(1) + 3, 13, 1, C.ink); }
        const msg = String(input.command ?? '').match(/-m\s+["']([^"']+)/)?.[1];
        if (msg) this.text(msg, x, row(2), C.dim, chars);
        break;
      }
      case 'planning': {
        (input.todos ?? []).slice(0, 4).forEach((todo, k) => {
          const status = todo.status;
          if (status === 'completed') this.icon('done', x, row(k), C.green);
          else if (status === 'in_progress') this.rect(x + 1, row(k) + 1, 5, 5, C.orange);
          else { this.rect(x + 1, row(k) + 1, 5, 1, C.dim); this.rect(x + 1, row(k) + 5, 5, 1, C.dim); this.rect(x + 1, row(k) + 1, 1, 5, C.dim); this.rect(x + 5, row(k) + 1, 1, 5, C.dim); }
          this.text(todo.content ?? todo.activeForm ?? '', x + 12, row(k), status === 'completed' ? C.dim : C.ink, chars - 2);
        });
        break;
      }
      case 'helpers': {
        this.text(input.description ?? firstLine(input.prompt)[0] ?? 'Working on a part of it', x, row(0), C.ink, chars);
        for (let k = 0; k < 3; k++) this.rect(x + k * 10, row(1) + 1, 6, 6, (Math.floor(t / 300) % 3) === k ? C.orange : C.bar2);
        break;
      }
      case 'usingTool': this.text(String(card.tool ?? '').replace(/^mcp__/, '').replace(/__/g, ' '), x, row(0), C.dim, chars); break;
      case 'thinking': for (let k = 0; k < 3; k++) this.rect(x + k * 9, row(0) + 1, 5, 5, (Math.floor(t / 280) % 3) === k ? C.orange : C.bar); break;
      case 'error': {
        if (card.command) this.text(`$ ${card.command}`, x, row(0), C.ink, chars);
        (card.lines ?? []).map(l => String(l).trim()).filter(Boolean).slice(0, 3).forEach((line, k) => this.text(line, x, row(k + 1), C.red, chars));
        break;
      }
      case 'approve': {
        let k = 0;
        if (card.command) this.text(`$ ${card.command}`, x, row(k++), C.ink, chars);
        (card.lines ?? []).map(l => String(l).trim()).filter(Boolean).slice(0, 4 - k).forEach(line => this.text(line, x, row(k++), C.dim, chars));
        break;
      }
      case 'waiting': {
        if (card.buttons === false) { this.text(card.text ?? '', x, row(0), C.dim, chars); break; }
        const pulse = Math.floor(t / 500) % 2 === 0;
        this.rect(x, row(0), 46, 17, C.ink); this.text('yes', x + 14, row(0) + 6, C.paper, 3);
        if (pulse) { this.rect(x - 2, row(0) - 2, 50, 1, C.orange); this.rect(x - 2, row(0) + 18, 50, 1, C.orange); this.rect(x - 2, row(0) - 2, 1, 21, C.orange); this.rect(x + 47, row(0) - 2, 1, 21, C.orange); }
        this.rect(x + 58, row(0), 46, 1, C.ink); this.rect(x + 58, row(0) + 16, 46, 1, C.ink); this.rect(x + 58, row(0), 1, 17, C.ink); this.rect(x + 103, row(0), 1, 17, C.ink);
        this.text('no', x + 75, row(0) + 6, C.ink, 2);
        break;
      }
      case 'done': {
        let r = 0;
        if (card.tests) {
          const { pass, fail } = card.tests, total = Math.min(8, pass + fail);
          for (let k = 0; k < total; k++) this.rect(x + k * 8, row(0) + 1, 5, 5, k < Math.floor(t / 70) ? (k < pass ? C.green : C.red) : C.bar);
          this.text(`${pass} passing`, x + total * 8 + 4, row(0), C.green, chars - total);
          r = 1;
        }
        const lines = wrap((card.lines ?? []).map(l => String(l).replace(/`/g, '')), chars), room = 4 - r;
        if (lines.length > room) lines[room - 1] = `${lines[room - 1].slice(0, chars - 2).replace(/[\s,.;:]+$/, '')}..`;
        lines.slice(0, room).forEach((line, k) => this.text(line, x, row(r + k), C.ink, chars));
        break;
      }
      default: break;
    }
  }

  /** Composes one frame. clip/frame: the mascot GIF frame (native RGBA with alpha) to stand on the horizon. */
  render(now, clip, frame) {
    const px = this.px;
    px.set(this.bg);
    this.clipY = LH;
    const T = this.T;
    if (T.decor === 'stars' || T.decor === 'sparkles') for (const s of this.stars) {
      const b = 0.5 + 0.5 * Math.sin(now / s.period * 6.283 + s.phase);
      if (b < (T.decor === 'sparkles' ? 0.6 : 0.3)) continue;
      const c = b > 0.85 ? T.star[2] : b > 0.55 ? T.star[1] : T.star[0];
      px[s.y * LW + s.x] = c;
      if (s.big && b > 0.85) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) px[(s.y + dy) * LW + s.x + dx] = T.star[1];
    }
    if (T.decor === 'clouds') for (const cl of this.clouds) {
      const cx = Math.round(((cl.x + now * cl.speed) % (LW + 60)) - 30);
      for (let y = 0; y < 9; y++) for (let x = 0; x < cl.w; x++) {
        const lump = y >= 4 || (y >= 1 && x > cl.w * 0.2 && x < cl.w * 0.75) || (y === 0 && x > cl.w * 0.35 && x < cl.w * 0.6);
        const X = cx + x, Y = cl.y + y;
        if (lump && X >= 0 && X < LW) px[Y * LW + X] = y === 8 ? T.star[0] : T.star[2];
      }
    }
    const data = clip.data, base = frame * 240 * 220 * 4;
    // (the clip is 240x220 native; it sits centred on the grid)
    for (let y = 0; y < 220; y++) {
      const ly = this.bodyY + y;
      if (ly < 0 || ly >= LH) continue;
      for (let x = 0; x < 240; x++) {
        const s = base + (y * 240 + x) * 4;
        if (!data[s + 3]) continue;
        const lx = this.bodyX + x;
        if (lx >= 0 && lx < LW) px[ly * LW + lx] = (0xff000000 | (data[s + 2] << 16) | (data[s + 1] << 8) | data[s]) >>> 0;
      }
    }
    this.drawCard(now);
    if (this.footer) { const n = Math.min(this.footer.length, 30); this.text(this.footer, Math.round((LW - n * FW) / 2), LH - 70, this.T.footer, 30); }
    // Upscale the grid to the 720x1280 camera frame.
    if (this.gridOnly) return px;
    const out = this.out32, OW = LW * GRID, OH = 1280;
    for (let ly = 0; ly < LH; ly++) {
      const row0 = ly * GRID;
      if (row0 >= OH) break;
      const o = row0 * OW;
      for (let lx = 0; lx < LW; lx++) { const c = px[ly * LW + lx]; out.fill(c, o + lx * GRID, o + lx * GRID + GRID); }
      for (let k = 1; k < GRID && row0 + k < OH; k++) out.copyWithin(o + k * OW, o, o + OW);
    }
    return this.out;
  }
}

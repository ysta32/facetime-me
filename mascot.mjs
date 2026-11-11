// The mascot video feed: GIF frames standing in a pixel scene, with a live work card above the head (scene.mjs).
import { loadFrames, NATIVE_H, NATIVE_W } from './bake.mjs';
import { Scene } from './scene.mjs';

export const WIDTH = 720, HEIGHT = 1280, FPS = 30;

/** Opaque bounding box of the resting frame, so effects like "!" and confetti keep their room above it. */
function bodyBox(clip) {
  let top = NATIVE_H, bottom = 0, left = NATIVE_W, right = 0;
  for (let y = 0; y < NATIVE_H; y++) for (let x = 0; x < NATIVE_W; x++) {
    if (clip.data[(y * NATIVE_W + x) * 4 + 3]) { top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x); }
  }
  return { top, bottom, left, right };
}

export const LOOK = {
  greeting: 'greeting', error: 'error-fluid', waiting: 'waiting-for-you-fluid', thinking: 'thinking-fluid',
  running: 'running-commands-fluid', done: 'done', idle: 'idle-fluid',
  // What the fixer is doing while it works, driven by its live tool calls (see activity.mjs).
  reading: 'reading-fluid', writing: 'writing-fluid', searchingCode: 'searching-code-fluid', searchingWeb: 'searching-web-fluid',
  testing: 'testing-fluid', committing: 'committing-fluid', helpers: 'directing-helpers-fluid', planning: 'plan-progress-fluid',
  usingTool: 'using-tool-fluid',
};
// The brief asks for the wave to play once; the manifest marks greeting as looping because it is a loop elsewhere.
const PLAY_ONCE_OVERRIDE = new Set(['greeting']);

export class Mascot {
  constructor({ now = Date.now, onChange = () => {}, theme, frames } = {}) {
    this.frames = frames ?? loadFrames();
    this.scene = new Scene({ body: bodyBox(this.frames[LOOK.idle]), theme });
    this.now = now;
    this.onChange = onChange;
    this.look = null;
    this.play('idle');
  }

  /** Swaps at once. A looping look that is already showing keeps its place; a play-once look always restarts at frame 1. */
  play(look) {
    const name = LOOK[look];
    const once = this.isOnce(name);
    if (this.look === look && !once) return;
    this.look = look;
    this.name = name;
    this.startedAt = this.now();
    this.onChange(look, name);
  }

  /** Shows a work card above the mascot (see scene.mjs for the kinds), or hides it with null. */
  card(card) { this.scene.set(card); }

  /** Adds facts to the card already showing, e.g. a command's output once it returns. */
  updateCard(patch) { this.scene.update(patch); }

  theme(id) { this.scene.setTheme(id); }

  /** A cute moment on top of whatever look is playing: hearts, sparkles, a speech bubble, a hop. */
  react(options) { this.scene.react(options, this.now()); }

  footer(text) { this.scene.footer = text ?? ''; }

  isOnce(name) { return !this.frames[name].loop || PLAY_ONCE_OVERRIDE.has(name); }

  /** True once a play-once look has reached its end and is holding its last frame. */
  finished() {
    const clip = this.frames[this.name];
    return this.isOnce(this.name) && this.now() - this.startedAt >= clip.durationMs;
  }

  frameIndex() {
    const clip = this.frames[this.name];
    let t = this.now() - this.startedAt;
    if (this.isOnce(this.name)) { if (t >= clip.durationMs) return clip.frames - 1; }
    else t %= clip.durationMs;
    let index = 0;
    while (index + 1 < clip.frames && clip.startsMs[index + 1] <= t) index++;
    return index;
  }

  /** The full 720x1280 RGBA camera frame for this instant. */
  render() {
    return this.scene.render(this.now(), this.frames[this.name], this.frameIndex());
  }
}

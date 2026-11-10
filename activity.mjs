// Turns the fixer's live stream-json output into mascot looks, so the video shows what Claude is actually doing.
// Each look is held for a moment so quick tool bursts don't strobe on the call.

const TEST = /\b(test|tests|jest|vitest|pytest|mocha|playwright|cypress|go test|cargo test|rspec|phpunit|xcodebuild test|swift test)\b/;
const COMMIT = /^\s*git\s+(commit|push|tag)\b/;
const SEARCH = /^\s*(grep|rg|ag|find|fd|ls|git (grep|log|show|diff|status))\b/;
const READ = /^\s*(cat|head|tail|less|sed -n|bat)\b/;
// Shell edits count as writing even when chained with a test run (`sed -i … && npm test`).
const SHELL_EDIT = /\b(sed|perl)\s+(-[a-zA-Z]*i|-i)|\btee\b|\bpatch\b|\bgit apply\b|(^|[^0-9>&])>{1,2}\s*(?!\/dev\/null|&)[\w./~-]+/;

/** The look for one tool call. */
export function lookForTool(name = '', input = {}) {
  const tool = String(name);
  if (/^(Read|NotebookRead)$/.test(tool)) return 'reading';
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return 'writing';
  if (/^(Grep|Glob|LS|LSP)$/.test(tool)) return 'searchingCode';
  if (/^(WebFetch|WebSearch)$/.test(tool) || /^mcp__.*(search|fetch|docs)/i.test(tool)) return 'searchingWeb';
  if (/^(Task|Agent)$/.test(tool)) return 'helpers';
  if (/^(TodoWrite|TaskCreate|TaskUpdate)$/.test(tool)) return 'planning';
  if (tool === 'Bash') {
    const command = String(input?.command ?? '');
    if (COMMIT.test(command)) return 'committing';
    if (SHELL_EDIT.test(command)) return 'writing';
    if (TEST.test(command)) return 'testing';
    if (SEARCH.test(command)) return 'searchingCode';
    if (READ.test(command)) return 'reading';
    return 'running';
  }
  return 'usingTool';
}

/**
 * Feeds stdout chunks in; calls onLook(look, detail) as activity changes and keeps the final `result` event.
 * Non-JSON output (an older or custom fixer) is ignored for looks and kept as plain text.
 */
export class FixStream {
  constructor({ onLook = () => {}, onResult = () => {}, holdMs = 1400, now = Date.now } = {}) {
    Object.assign(this, { onLook, onResult, holdMs, now });
    this.results = {};
    this.pending = '';
    this.plain = '';
    this.result = null;
    this.current = null;
    this.shownAt = 0;
    this.queued = null;
    this.timer = null;
    this.steps = [];
  }

  push(chunk) {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop();
    for (const line of lines) this.line(line);
  }

  end() {
    if (this.pending) this.line(this.pending);
    this.pending = '';
    clearTimeout(this.timer);
  }

  line(text) {
    if (!text.trim()) return;
    let event;
    try { event = JSON.parse(text); } catch { this.plain += `${text}\n`; return; }
    if (event.type === 'result') { this.result = event; return; }
    if (event.type === 'user') {
      for (const part of event.message?.content ?? []) {
        if (part.type !== 'tool_result') continue;
        const text = typeof part.content === 'string' ? part.content : (part.content ?? []).map(p => p.text ?? '').join('\n');
        this.results[part.tool_use_id] = text;
        this.onResult(part.tool_use_id, text, Boolean(part.is_error));
      }
      return;
    }
    if (event.type !== 'assistant') return;
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use') {
        const look = lookForTool(part.name, part.input);
        this.steps.push({ look, tool: part.name });
        this.show(look, { tool: part.name, input: part.input, id: part.id });
      } else if ((part.type === 'thinking' || part.type === 'text') && !this.current) {
        this.show('thinking', { tool: part.type });
      }
    }
  }

  /** Switches now if the last look has been up long enough, otherwise once it has. The latest request wins. */
  show(look, detail) {
    if (look === this.current && !this.queued) return;
    const wait = this.holdMs - (this.now() - this.shownAt);
    if (wait <= 0 || !this.current) return this.apply(look, detail);
    this.queued = { look, detail };
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = null;
      const next = this.queued; this.queued = null;
      if (next && next.look !== this.current) this.apply(next.look, next.detail);
    }, wait);
  }

  /** Applies a held look once it is due. The live call relies on the timer; offline renders call this per frame. */
  tick() {
    if (this.queued && this.now() - this.shownAt >= this.holdMs) {
      const next = this.queued; this.queued = null; clearTimeout(this.timer); this.timer = null;
      if (next.look !== this.current) this.apply(next.look, next.detail);
    }
  }

  apply(look, detail) {
    this.current = look;
    this.shownAt = this.now();
    // A result that came back while this look was queued travels with it.
    this.onLook(look, detail?.id && this.results[detail.id] != null ? { ...detail, output: this.results[detail.id] } : detail);
  }

  /** The fixer's final sentence and whether it reported an error. */
  outcome() {
    if (this.result) return { text: String(this.result.result ?? '').trim(), isError: Boolean(this.result.is_error) };
    const plain = this.plain.trim();
    try { const parsed = JSON.parse(plain); return { text: String(parsed.result ?? plain), isError: Boolean(parsed.is_error) }; } catch { return { text: plain, isError: false }; }
  }
}

// `facetime-me --demo`: opens a clean, big-font window and runs the take in it.
// `facetime-me --demo --here`: runs the take in the current terminal.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, cpSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FOLDER = join(HERE, 'acme-web');
const FEED = join(HERE, '..', 'state', 'demo-events.log');
const STATE_DIR = join(HERE, '..', 'state');
const LOCK = join(STATE_DIR, 'call.lock');
const SELF = join(HERE, '..', 'bin', 'facetime-me.mjs');
const PROMPT = "Run `npm run build`. If it fails, do not try to fix anything and do not run anything else: reply with exactly one short sentence naming the failure, ending with \"Calling you now.\"";

/** The demo's child Claude only gets this repo's hook, wherever the repo was cloned. */
function demoSettings() {
  const path = join(STATE_DIR, 'demo-settings.json');
  const hooks = { PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command: SELF, async: true }] }] };
  writeFileSync(path, JSON.stringify({ hooks }));
  return path;
}

const c = { red: '\x1b[1;31m', green: '\x1b[1;32m', yellow: '\x1b[1;33m', dim: '\x1b[2m', bold: '\x1b[1m', coral: '\x1b[38;5;209m', off: '\x1b[0m' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const say = text => process.stdout.write(`${text}\n`);

function openWindow() {
  const script = `
tell application "Terminal"
  activate
  set take to do script "clear; exec ${SELF} --demo --here"
  set tabSettings to current settings of take
  set font name of take to "Menlo"
  set font size of take to 24
  set background color of take to {3000, 3000, 3600}
  set normal text color of take to {60000, 60000, 60000}
  set bold text color of take to {65535, 65535, 65535}
  set number of columns of window 1 to 84
  set number of rows of window 1 to 26
end tell`;
  execFileSync('osascript', ['-e', script], { stdio: 'ignore' });
}

const colorize = text => text.split('\n').map(line => {
  if (/✗|Error:/.test(line)) return `${c.red}${line.replace(/\x1b\[[0-9;]*m/g, '')}${c.off}`;
  if (/^\s*>\s*\d+ \|/.test(line)) return `${c.red}${line}${c.off}`;
  return line;
}).join('\n');

function render(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'assistant') {
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use') say(`\n${c.coral}⏺${c.off} ${c.bold}Bash${c.off}(${part.input?.command ?? ''})`);
      if (part.type === 'text' && part.text.trim()) say(`\n${c.coral}⏺${c.off} ${part.text.trim()}`);
    }
  }
  if (event.type === 'user') {
    for (const part of event.message?.content ?? []) {
      if (part.type !== 'tool_result') continue;
      const text = typeof part.content === 'string' ? part.content : (part.content ?? []).map(p => p.text ?? '').join('\n');
      const body = text.split('\n').filter(l => !/^Exit code \d+$/.test(l) && !/^> /.test(l)).join('\n').trim();
      say(`\n${colorize(body)}`);
    }
  }
}

async function followCall() {
  let seen = 0, finished = false;
  const deadline = Date.now() + 120000;
  while (!finished && Date.now() < deadline) {
    await sleep(200);
    const lines = existsSync(FEED) ? readFileSync(FEED, 'utf8').trim().split('\n').filter(Boolean) : [];
    for (const event of lines.slice(seen)) {
      if (event === 'ringing') say(`\n${c.coral}☎${c.off}  ${c.bold}FaceTiming you…${c.off}`);
      if (event === 'answered') say(`${c.dim}   connected${c.off}`);
      if (event === 'fix-start') say(`\n${c.coral}⏺${c.off} Adding AUTH_SECRET to .env.local and rebuilding…`);
      if (event === 'fix-ok') {
        const log = readFileSync(join(FOLDER, '.build.log'), 'utf8').trim();
        say(`\n${log}\n\n${c.green}✓ Build fixed.${c.off}`);
      }
      if (event === 'fix-failed') say(`\n${c.red}✗ The fix did not work.${c.off}`);
      if (event === 'summary-sent') say(`${c.dim}   summary texted${c.off}`);
      if (event.startsWith('call-failed')) say(`\n${c.red}Call failed: ${event.slice(12)}${c.off}`);
      if (event === 'call-done') finished = true;
    }
    seen = lines.length;
  }
  if (!finished) say(`\n${c.yellow}The call did not report an end within two minutes. See ~/facetime-me/state/facetime-me.log${c.off}`);
}

export async function runDemo(args) {
  if (!args.includes('--here')) return openWindow();
  if (existsSync(LOCK)) {
    if (Date.now() - statSync(LOCK).mtimeMs < 8 * 60000) { say(`${c.yellow}A call is still in progress. Hang up and wait a few seconds, then run this again.${c.off}`); process.exit(1); }
    rmSync(LOCK, { recursive: true, force: true });
  }
  rmSync(FOLDER, { recursive: true, force: true });
  cpSync(join(HERE, 'template'), FOLDER, { recursive: true });
  writeFileSync(FEED, '');
  // Warm the agent during the countdown so the call fires right after the error, not several seconds later.
  const logFd = openSync(join(STATE_DIR, 'worker.log'), 'a');
  const warm = spawn(process.execPath, [join(HERE, '..', 'agent.mjs'), 'start'], { cwd: join(HERE, '..'), detached: true, stdio: ['ignore', logFd, logFd] });
  warm.unref();
  closeSync(logFd);
  writeFileSync(join(STATE_DIR, 'warm-worker.json'), JSON.stringify({ pid: warm.pid }));

  say(`${c.yellow}⚠  Demo mode skips the cooldown. Every run places a real FaceTime call.${c.off}`);
  say(`${c.dim}   Start recording now.${c.off}\n`);
  for (let n = 5; n > 0; n--) { process.stdout.write(`\r   ${c.bold}Starting in ${n}…${c.off}  `); await sleep(1000); }
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  say(`${c.coral}acme-web${c.off} ${c.dim}main${c.off}\n`);
  say(`${c.bold}>${c.off} run the build`);

  const child = spawn('claude', ['-p', PROMPT, '--model', 'haiku', '--output-format', 'stream-json', '--verbose',
    '--allowedTools', 'Bash(npm run build)', '--settings', demoSettings(), '--setting-sources', '', '--strict-mcp-config'],
  { cwd: FOLDER, env: { ...process.env, FACETIME_ME_DEMO: '1', CHERT_FACETIME_ALERTS: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
  let pending = '';
  child.stdout.on('data', chunk => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    lines.forEach(render);
  });
  await new Promise(resolve => child.on('close', resolve));
  await followCall();
  say(`\n${c.dim}Take finished.${c.off}`);
  process.exit(0);
}

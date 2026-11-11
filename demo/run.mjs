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

const quote = raw => { try { return JSON.parse(raw); } catch { return raw; } };
const ASKS = ['Fix the build', 'Push to main', 'Deploy to staging'];

async function followCall() {
  let seen = 0, finished = false;
  const deadline = Date.now() + 4 * 60000;
  while (!finished && Date.now() < deadline) {
    await sleep(150);
    const lines = existsSync(FEED) ? readFileSync(FEED, 'utf8').split('\n').filter(Boolean) : [];
    for (const event of lines.slice(seen)) {
      const [kind, ...rest] = event.split(' '), arg = rest.join(' ');
      if (kind === 'ringing') say(`\n${c.coral}☎${c.off}  ${c.bold}FaceTiming you…${c.off}`);
      else if (kind === 'answered') say(`${c.green}   ● connected${c.off}`);
      else if (kind === 'said') say(`\n   ${c.coral}Claude${c.off}  ${quote(arg)}`);
      else if (kind === 'heard') say(`   ${c.bold}You${c.off}     ${quote(arg)}`);
      else if (kind === 'ask') say(`   ${c.yellow}⏸  ${quote(arg) || 'Okay?'}${c.off} ${c.dim}waiting for your answer on FaceTime${c.off}`);
      else if (kind === 'yes') say(`   ${c.green}✓ approved on FaceTime${c.off} ${c.dim}(${ASKS[Number(arg)] ?? 'go ahead'})${c.off}`);
      else if (kind === 'term') {
        const text = quote(arg);
        if (text.startsWith('tool ')) say(`\n${c.coral}⏺${c.off} ${c.bold}${text.slice(5)}${c.off}`);
        else if (text.startsWith('out ')) say(text.slice(4).split('\n').slice(0, 8).map((l, i) => `  ${c.dim}${i ? ' ' : '⎿'}${c.off}  ${/✔|✓|built in|Live at|pass 12/.test(l) ? c.green : /✖|✗|fail [1-9]/.test(l) ? c.red : ''}${l}${c.off}`).join('\n'));
      }
      else if (kind === 'stage-failed') say(`\n${c.red}✗ That step failed.${c.off}`);
      else if (kind === 'fix-ok') say(`\n${c.green}✓ Fixed, pushed and live on staging, all from one FaceTime call.${c.off}`);
      else if (kind === 'summary-sent') say(`${c.dim}   summary texted${c.off}`);
      else if (kind === 'call-failed') say(`\n${c.red}Call failed: ${arg}${c.off}`);
      else if (kind === 'call-done') finished = true;
    }
    seen = lines.length;
  }
  if (!finished) say(`\n${c.yellow}The call did not report an end within four minutes. See ~/facetime-me/state/facetime-me.log${c.off}`);
}

/** A real repo with a local "origin", so the commit and push on the call are real too. */
function makeRepo() {
  const remote = join(STATE_DIR, 'demo-remote.git');
  rmSync(remote, { recursive: true, force: true });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Acme Dev', '-c', 'user.email=dev@acme-web.dev', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: FOLDER, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'acme-web 1.4.2');
  execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' });
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'HEAD:main');
  git('branch', '-q', '-M', 'main');
  git('branch', '-q', '--set-upstream-to=origin/main');
}

export async function runDemo(args) {
  if (!args.includes('--here')) return openWindow();
  if (existsSync(LOCK)) {
    if (Date.now() - statSync(LOCK).mtimeMs < 8 * 60000) { say(`${c.yellow}A call is still in progress. Hang up and wait a few seconds, then run this again.${c.off}`); process.exit(1); }
    rmSync(LOCK, { recursive: true, force: true });
  }
  rmSync(FOLDER, { recursive: true, force: true });
  cpSync(join(HERE, 'template'), FOLDER, { recursive: true });
  makeRepo();
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

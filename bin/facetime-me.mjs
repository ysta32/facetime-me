#!/usr/bin/env node
// Claude Code hook + command. Decides whether something is worth a FaceTime call, then hands off to a detached runner.
//   (hook)                 reads the hook's JSON on stdin
//   facetime-me --demo     records-friendly demo, see ~/facetime-me/demo
//   facetime-me --on|--off|--status
//   facetime-me --setup    one-time setup: Chert sign-in, phone verification, keys, hooks
//   facetime-me --key      save a new Chert project API key (needed to place calls)
//   facetime-me --listen   answer FaceTime calls to your Chert line until Ctrl+C (any terminal)
//   facetime-me --preview  see the call screen in your browser: try personalities, voices and backgrounds
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The repo this file lives in (symlinks to it, like ~/.claude/hooks/facetime-me, resolve here).
const HOME = dirname(dirname(fileURLToPath(import.meta.url))), STATE = join(HOME, 'state');
const STATE_FILE = join(STATE, 'state.json'), OFF_FILE = join(STATE, 'off'), LOCK = join(STATE, 'call.lock');
const COOLDOWN_MS = 10 * 60000, LOCK_STALE_MS = 8 * 60000, SEEN_TTL_MS = 30 * 86400000;
const { log, readJson, writeJson } = await import(pathToFileURL(join(HOME, 'lib.mjs')).href);

const TEST_CMD = /\b(test|jest|vitest|pytest|mocha|go test|cargo test)\b/;
// Commands that fail as a normal part of looking around, not because anything is wrong.
const PROBE = /^\s*(grep|rg|egrep|fgrep|ag|find|ls|test|\[|\[\[|diff|cmp|which|command|type|pgrep|pkill|kill|cat|head|tail|stat|file|git (diff|status|log|show|grep|rev-parse|ls-files|check-ignore|merge-base|config)|gh api|curl)\b/;

const offSwitch = () => process.env.CHERT_FACETIME_ALERTS === '0' || existsSync(OFF_FILE);
const lastLines = (text, count = 6) => String(text ?? '').split('\n').map(line => line.trimEnd()).filter(Boolean).slice(-count).join('\n').slice(-900);
const fingerprint = (text) => createHash('sha256').update(String(text).toLowerCase().replace(/\b\d+\b/g, 'N').replace(/\s+/g, ' ')).digest('hex').slice(0, 20);
const oneLine = (text, max) => { const flat = String(text ?? '').replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

/** Turns a hook payload into a job for the call, or null when this event should stay quiet. */
function jobFromHook(hook) {
  const project = basename(hook.cwd || process.cwd());
  const event = hook.hook_event_name;
  const session = hook.session_id;
  const quietLines = { ask: 'Want me to fix it?', noAnswer: "No answer, so I'll leave it. Check your texts.", bye: "Okay, I'll leave it. Bye." };

  if (event === 'PostToolUseFailure') {
    if (hook.is_interrupt) return null;
    if (hook.tool_name !== 'Bash') return null;
    const command = hook.tool_input?.command ?? '';
    if (PROBE.test(command)) return null;
    const tail = lastLines(hook.error);
    const args = ['-p', `The developer approved this over FaceTime. The command \`${oneLine(command, 300)}\` failed with:\n${tail}\n\nFix the cause, verify by re-running it, then reply in one plain sentence of under 15 words saying what you changed. Do not commit or push.`, '--output-format', 'stream-json', '--verbose', '--max-turns', '25'];
    if (session) args.push('--resume', session, '--fork-session');
    if (hook.permission_mode) args.push('--permission-mode', hook.permission_mode);
    return {
      kind: 'failure', canFix: true, look: 'error', project, dedupeKey: fingerprint(`${project}|${command}|${tail}`),
      card: { kind: 'error', title: TEST_CMD.test(command) ? 'Tests failed' : 'A command failed', command: oneLine(command, 60), lines: tail.split('\n').slice(-3) },
      context: `Project: ${project}\nFailing command: ${oneLine(command, 200)}\nLast lines of the error:\n${tail}`,
      summary: `${project}: \`${oneLine(command, 70)}\` failed. ${oneLine(tail.split('\n').slice(-1)[0], 110)}`,
      fix: { command: 'claude', args, cwd: hook.cwd || process.cwd(), timeoutMs: 180000 },
      lines: { ...quietLines, fixed: "Done.", explainPrompt: 'In ONE short spoken sentence of under 20 words, say in the first person what just failed for you and why, using only the facts you were given. Name the project or file, not a path. Do not ask anything, do not offer anything.' },
    };
  }
  if (event === 'StopFailure') {
    const reason = hook.error ?? 'unknown';
    return {
      kind: 'stopped', canFix: false, look: 'error', project, card: { kind: 'error', title: 'Claude Code stopped', lines: [String(reason), oneLine(hook.last_assistant_message, 80)].filter(Boolean) }, dedupeKey: fingerprint(`${project}|stop|${reason}`),
      context: `Project: ${project}\nThe task stopped with this error type: ${reason}\nDetails: ${oneLine(hook.error_details ?? hook.last_assistant_message, 300)}`,
      summary: `${project}: Claude Code stopped with ${reason}. ${oneLine(hook.last_assistant_message, 120)}`,
      lines: { ...quietLines, bye: "That's all. Bye.", explainPrompt: 'In ONE short spoken sentence of under 20 words, say in the first person that you stopped and why, using only the facts you were given. Do not ask anything.' },
    };
  }
  if (event === 'Notification') {
    const kind = hook.notification_type;
    if (!['permission_prompt', 'elicitation_dialog', 'agent_needs_input'].includes(kind)) return null;
    // Permission prompts are answered on their own call by the PermissionRequest hook (approve.mjs).
    if (kind === 'permission_prompt' && readJson(join(HOME, 'config.json'), {}).approvals?.enabled !== false) return null;
    return {
      kind: 'waiting', canFix: false, look: 'waiting', project, card: { kind: 'waiting', title: 'Claude Code needs you', buttons: false, text: oneLine(hook.message, 48) }, dedupeKey: fingerprint(`${project}|${session}|${kind}|${hook.message}`),
      context: `Project: ${project}\nClaude Code is waiting on the developer. Its notice says: ${oneLine(hook.message, 240)}`,
      summary: `${project}: Claude Code is waiting on you. ${oneLine(hook.message, 150)}`,
      lines: { ...quietLines, bye: 'Come back to the terminal when you can. Bye.', explainPrompt: 'In ONE short spoken sentence of under 20 words, say in the first person what you are waiting on, using only the facts you were given. Do not ask anything.' },
    };
  }
  return null;
}

function demoJob() {
  const folder = join(HOME, 'demo', 'acme-web');
  return {
    kind: 'failure', canFix: true, demo: true, look: 'error', project: 'acme-web', dedupeKey: null, greetMs: 2400,
    card: { kind: 'error', title: 'Build failed', command: 'npm run build', lines: ['Missing AUTH_SECRET', 'in src/auth.ts'] },
    context: 'Project: acme-web. The build failed on a missing AUTH_SECRET env var in auth.ts.',
    summary: 'acme-web: `npm run build` failed on a missing AUTH_SECRET in auth.ts (demo).',
    fix: { command: process.execPath, args: [join(HOME, 'demo', 'apply-fix.mjs'), folder], cwd: folder, timeoutMs: 15000 },
    lines: {
      explain: 'Hey, your build just failed on a missing env var in auth.ts.',
      ask: 'Want me to fix it?',
      fixed: "Done, it's building now.",
      noAnswer: "No answer, so I'll leave it. Bye.",
      bye: "Okay, I'll leave it. Bye.",
    },
  };
}

function takeLock() {
  try { mkdirSync(LOCK); return true; } catch { /* held */ }
  try { if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) { rmSync(LOCK, { recursive: true, force: true }); mkdirSync(LOCK); return true; } } catch { /* lost a race */ }
  return false;
}

function launch(job) {
  const path = join(STATE, `job-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(path, JSON.stringify(job), { mode: 0o600 });
  spawn(process.execPath, [join(HOME, 'place-call.mjs'), path], { cwd: HOME, detached: true, stdio: 'ignore' }).unref();
}

/** Escapes raw control characters that sit inside JSON strings, leaving structural whitespace alone. */
function escapeInStrings(text) {
  let out = '', inString = false, escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < ' ') { out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`; continue; }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

async function fromHook() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let hook;
  // A raw newline or tab inside a string (seen 2026-11-05) breaks strict JSON; escape stray control characters and retry.
  try { hook = JSON.parse(raw || '{}'); }
  catch { hook = JSON.parse(escapeInStrings(raw)); }
  // Approvals answer Claude Code synchronously: print the decision, or nothing to leave it alone.
  if (hook.hook_event_name === 'PreToolUse' || hook.hook_event_name === 'PermissionRequest') {
    if (offSwitch() || process.env.FACETIME_ME_DEMO === '1') return;
    const { approvalFromHook } = await import(pathToFileURL(join(HOME, 'approve.mjs')).href);
    const out = await approvalFromHook(hook);
    if (out) process.stdout.write(JSON.stringify(out));
    return;
  }
  // Subagents retry their own failures, and nothing a subagent does is waiting on a person.
  if (hook.agent_id) return;
  const demoRun = process.env.FACETIME_ME_DEMO === '1';
  if (!demoRun && offSwitch()) return;
  // The headless fix and the demo's own child must never start another call.
  const job = demoRun ? (hook.hook_event_name === 'PostToolUseFailure' ? demoJob() : null) : jobFromHook(hook);
  if (!job) return;
  if (!takeLock()) return log(`skipped ${job.kind}: a call is already in progress`);
  if (!demoRun) {
    const state = readJson(STATE_FILE, { seen: {} });
    const now = Date.now();
    state.seen = Object.fromEntries(Object.entries(state.seen ?? {}).filter(([, at]) => now - at < SEEN_TTL_MS));
    const quiet = state.lastCallAt && now - state.lastCallAt < COOLDOWN_MS ? 'cooldown' : state.seen[job.dedupeKey] ? 'same error already called' : null;
    if (quiet) { rmSync(LOCK, { recursive: true, force: true }); return log(`skipped ${job.kind}: ${quiet}`); }
    state.lastCallAt = now;
    state.seen[job.dedupeKey] = now;
    writeJson(STATE_FILE, state);
  }
  log(`calling for ${job.kind}: ${job.summary}`);
  launch(job);
}

const arg = process.argv[2];
if (arg === '--off') { writeFileSync(OFF_FILE, ''); console.log('FaceTime alerts are off.'); }
else if (arg === '--on') { rmSync(OFF_FILE, { force: true }); console.log(process.env.CHERT_FACETIME_ALERTS === '0' ? 'Off file cleared, but CHERT_FACETIME_ALERTS=0 is still set in this shell.' : 'FaceTime alerts are on.'); }
else if (arg === '--status') {
  const state = readJson(STATE_FILE, {});
  const left = state.lastCallAt ? Math.max(0, COOLDOWN_MS - (Date.now() - state.lastCallAt)) : 0;
  console.log(`alerts: ${offSwitch() ? 'off' : 'on'}\ncooldown: ${left ? `${Math.ceil(left / 60000)} min left` : 'none'}\nerrors already called about: ${Object.keys(state.seen ?? {}).length}\nlog: ${join(STATE, 'facetime-me.log')}`);
}
else if (arg === '--demo') {
  const { runDemo } = await import(pathToFileURL(join(HOME, 'demo', 'run.mjs')).href);
  await runDemo(process.argv.slice(3));
}
else if (arg === '--setup') {
  const { setup } = await import(pathToFileURL(join(HOME, 'setup.mjs')).href);
  await setup(process.argv.slice(3));
}
else if (arg === '--key') {
  const { setKey } = await import(pathToFileURL(join(HOME, 'setup.mjs')).href);
  await setKey();
}
else if (arg === '--listen') {
  const { listen } = await import(pathToFileURL(join(HOME, 'listen.mjs')).href);
  await listen();
}
else if (arg === '--preview') {
  const { preview } = await import(pathToFileURL(join(HOME, 'preview.mjs')).href);
  await preview();
}
else if (arg) { console.error('usage: facetime-me [--setup] [--key] [--listen] [--preview] [--demo [--here]] [--on] [--off] [--status]'); process.exit(2); }
else {
  try { await fromHook(); } catch (error) { log(`hook error: ${error.message}`); }
  process.exit(0);
}

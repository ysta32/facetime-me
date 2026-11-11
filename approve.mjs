// Approvals over FaceTime. Claude Code asks this hook before a tool runs; for anything risky it rings you,
// the mascot shows the exact command, and your "yes" or "no" goes back to Claude Code as the decision.
//
//   PermissionRequest   normal modes: fires exactly when Claude Code would show a permission prompt.
//   PreToolUse          bypass mode ("--dangerously-skip-permissions"): nothing prompts, so risky calls are
//                       caught here by the policy below and routed to the call instead.
//
// If the call can't be placed, isn't answered, or you don't decide, it falls back to the terminal prompt.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { config, HOME, log, readJson, resultPath, STATE, writeJson } from './lib.mjs';

const LOCK = join(STATE, 'call.lock'), ALWAYS = join(STATE, 'approvals.json');
const WAIT_FOR_LINE_MS = 90_000, DECIDE_MS = 270_000, LOCK_STALE_MS = 8 * 60000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const oneLine = (text, max) => { const flat = String(text ?? '').replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

// What counts as risky when nothing else is asking. Reads, builds and tests stay silent.
const RISKY_BASH = [
  /(^|[;&|(]\s*|\bsudo\s+|\bxargs\s+)(rm|rmdir|shred|dd|mkfs\S*|chmod|chown|kill|killall|pkill|launchctl|crontab|shutdown|reboot|diskutil)\b/,
  /\bsudo\b/, /\bgit\s+(push|reset\s+--hard|clean\b|checkout\s+--\s|branch\s+-D|rebase|filter-(branch|repo)|tag\s+-d|stash\s+(drop|clear))/,
  /--force\b|\s-f\s.*\bpush\b/, /\b(npm|pnpm|yarn|bun)\s+(publish|unpublish|deprecate)\b/,
  /\b(vercel|netlify|fly|flyctl|firebase|wrangler|heroku|railway)\b[^|]*\b(deploy|--prod|promote|rollback|delete|rm)\b/,
  /\bterraform\s+(apply|destroy|import)\b/, /\bkubectl\s+(apply|delete|scale|rollout|drain|patch|edit)\b/,
  /\baws\s+\S+\s+\S*(delete|terminate|remove|rm|put|create|update|modify)\S*/, /\bgcloud\b.*\b(delete|deploy|create)\b/,
  /\bgh\s+(pr\s+(merge|close)|repo\s+(delete|create|edit)|release\s+(create|delete)|secret\s+set|api\s+.*-X\s*(POST|PUT|PATCH|DELETE))/i,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/, /\b(curl)\b.*\s-X\s*(POST|PUT|PATCH|DELETE)\b/i,
  /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b|\bDELETE\s+FROM\b/i, /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/,
  /\b(mv|cp)\b[^;&|]*\s(\/|~\/)(etc|usr|System|Library|bin)\b/, />\s*(\/etc\/|~\/\.(ssh|aws|zshrc|bashrc))/,
];
const RISKY_MCP = /(send|delete|trash|remove|publish|deploy|buy|pay|transfer|share|forward|reply|merge|cancel|rollback|promote|purchase|invite)/i;
const SENSITIVE_FILE = /(^|\/)(\.env[^/]*|\.ssh\/|\.aws\/|\.npmrc|\.netrc|credentials[^/]*|id_[a-z0-9]+|settings(\.local)?\.json)$/i;

/** Why this tool call needs a human, or null when it can run. */
export function riskOf(hook) {
  const tool = hook.tool_name ?? '', input = hook.tool_input ?? {};
  const extra = config().approvals?.alsoAsk;
  if (tool === 'Bash') {
    const command = String(input.command ?? '');
    if (extra && new RegExp(extra, 'i').test(command)) return 'matches your alsoAsk rule';
    return RISKY_BASH.some(rule => rule.test(command)) ? 'a command that changes or deletes things' : null;
  }
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
    const file = String(input.file_path ?? input.notebook_path ?? '');
    if (SENSITIVE_FILE.test(file)) return 'a sensitive file';
    const rel = relative(hook.cwd || process.cwd(), resolve(hook.cwd || process.cwd(), file));
    return rel.startsWith('..') || isAbsolute(rel) ? 'a file outside the project' : null;
  }
  if (tool.startsWith('mcp__')) return RISKY_MCP.test(tool.split('__').pop()) ? 'an action in a connected app' : null;
  return null;
}

/** A short, speakable description plus what the mascot's screen card shows. */
function describe(hook) {
  const tool = hook.tool_name ?? 'a tool', input = hook.tool_input ?? {};
  if (tool === 'Bash') return { what: `run \`${oneLine(input.command, 300)}\``, card: { command: oneLine(input.command, 60), lines: [oneLine(input.description, 40)].filter(Boolean) }, key: `Bash:${String(input.command ?? '').trim().split(/\s+/).slice(0, 2).join(' ')}` };
  if (input.file_path || input.notebook_path) { const file = input.file_path ?? input.notebook_path; return { what: `${tool === 'Write' ? 'write' : 'edit'} ${file}`, card: { lines: [`${tool} ${basename(file)}`, oneLine(file, 40)] }, key: `${tool}:${file}` }; }
  const name = tool.replace(/^mcp__/, '').replace(/__/g, ' ');
  return { what: `use ${name} with ${oneLine(JSON.stringify(input), 300)}`, card: { lines: [oneLine(name, 40), oneLine(JSON.stringify(input), 80)] }, key: tool };
}

const decision = (event, behavior, reason) => event === 'PermissionRequest'
  ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: reason } } }
  : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: behavior, permissionDecisionReason: reason } };

async function takeLock() {
  const until = Date.now() + WAIT_FOR_LINE_MS;
  while (Date.now() < until) {
    try { mkdirSync(LOCK); return true; } catch { /* another call is on */ }
    try { if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) rmSync(LOCK, { recursive: true, force: true }); } catch { /* raced */ }
    await sleep(1000);
  }
  return false;
}

/**
 * Handles a PreToolUse or PermissionRequest hook. Returns the JSON to print, or null to let Claude Code
 * carry on as it would have (no opinion).
 */
export async function approvalFromHook(hook) {
  const event = hook.hook_event_name;
  const settings = config();
  if (settings.approvals?.enabled === false) return null;
  if (event === 'PreToolUse' && hook.permission_mode !== 'bypassPermissions') return null;
  const why = event === 'PermissionRequest' ? 'Claude Code asked for permission' : riskOf(hook);
  if (!why) return null;

  const { what, card, key } = describe(hook);
  const always = readJson(ALWAYS, {});
  if (hook.session_id && always[hook.session_id]?.includes(key)) return decision(event, 'allow', 'You said "always" on FaceTime for this session');

  // Fallback: the terminal prompt. In bypass mode "ask" brings it back for just this call.
  const fallback = reason => { log(`approval fell back to terminal: ${reason}`); return event === 'PreToolUse' ? decision(event, 'ask', `FaceTime approval unavailable (${reason})`) : null; };
  if (!settings.phone) return fallback('no phone in config.json');
  if (existsSync(join(STATE, 'key-invalid'))) return fallback('Chert refused the API key; run facetime-me --key');
  if (!(await takeLock())) return fallback('another call is still on the line');

  const project = basename(hook.cwd || process.cwd());
  const room = `ok-${randomBytes(5).toString('hex')}`;
  const job = {
    kind: 'approval', approval: true, canFix: false, look: 'waiting', project, room, dedupeKey: null,
    card: { kind: 'approve', title: 'Allow this?', ...card },
    context: `Project: ${project}\nClaude Code wants to ${what}\nWhy it needs you: ${why}${hook.tool_input?.description ? `\nClaude's own description: ${oneLine(hook.tool_input.description, 200)}` : ''}`,
    summary: `${project}: Claude Code wants to ${oneLine(what, 160)}`,
    lines: {
      explainPrompt: 'In ONE short spoken sentence of under 20 words, starting with "Hey,", say what Claude Code wants to do, in plain words, using only the facts. Do not read the command out in full. Do not ask anything yet.',
      ask: 'Okay to go ahead?',
      approved: 'Okay, going ahead.',
      denied: "Okay, I'll stop it.",
      noAnswer: "No answer, so it's waiting in your terminal. Bye.",
      bye: "It's waiting in your terminal. Bye.",
    },
  };
  const jobPath = join(STATE, `job-${room}.json`);
  writeFileSync(jobPath, JSON.stringify(job), { mode: 0o600 });
  log(`approval call for ${project}: ${oneLine(what, 120)}`);
  const caller = spawn(process.execPath, [join(HOME, 'place-call.mjs'), jobPath], { cwd: HOME, detached: true, stdio: 'ignore' });
  let callerDone = false;
  caller.on('exit', () => { callerDone = true; });
  caller.unref();

  const until = Date.now() + DECIDE_MS;
  while (Date.now() < until) {
    const result = readJson(resultPath(room), {});
    if (result.decision) {
      if (result.decision.behavior === 'allow' && result.decision.always && hook.session_id) {
        const saved = readJson(ALWAYS, {});
        saved[hook.session_id] = [...new Set([...(saved[hook.session_id] ?? []), key])];
        writeJson(ALWAYS, saved);
      }
      log(`approval ${result.decision.behavior} on FaceTime: ${oneLine(what, 120)}`);
      return result.decision.behavior === 'allow'
        ? decision(event, 'allow', 'Approved by the developer on FaceTime')
        : decision(event, 'deny', `The developer said no on FaceTime${result.decision.reason ? `: ${oneLine(result.decision.reason, 200)}` : ''}. Do not retry this; ask them what to do instead.`);
    }
    if (callerDone && !existsSync(LOCK)) return fallback('the call ended without a decision');
    await sleep(500);
  }
  return fallback('no decision in time');
}

// `facetime-me --setup` (or `npm run setup`): everything needed before `facetime-me --listen`, in one go.
// Safe to re-run: every step checks what is already done and skips it.
//   1. installs dependencies           4. writes your LiveKit + OpenAI keys to .env.local (never printed)
//   2. Chert sign-in + phone check      5. runs `chert doctor`
//   3. remembers your Chert project     6. optional: Claude Code hooks so the mascot calls YOU when something breaks
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CONFIG_PATH, HOME, STATE, config, writeJson } from './lib.mjs';

const ENV = join(HOME, '.env.local');
const BIN = join(HOME, 'bin', 'facetime-me.mjs');
const c = { bold: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m` };
const step = (n, text) => console.log(`\n${c.bold(`[${n}/6]`)} ${text}`);
const ok = text => console.log(`  ${c.green('✓')} ${text}`);
const fail = text => { console.error(`  ${c.red('✗')} ${text}`); process.exit(1); };

/** Asks one question. Secrets are read without echo, so they never show on screen or in scrollback. */
function ask(question, { secret = false, fallback = '' } = {}) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (secret) rl._writeToOutput = text => { if (/\n|\r/.test(text) || text.startsWith(question)) process.stdout.write(text.startsWith(question) ? question : '\n'); };
    rl.question(question, answer => { rl.close(); resolve(answer.trim() || fallback); });
  });
}
const yes = async (question, byDefault) => {
  const answer = (await ask(`  ${question} ${byDefault ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  return answer ? answer.startsWith('y') : byDefault;
};

const chertBin = () => [join(HOME, 'node_modules', '.bin', 'chert')].find(existsSync);
const chert = (args, opts = {}) => spawnSync(chertBin(), args, { cwd: HOME, encoding: 'utf8', ...opts });
const chertJson = args => {
  const run = chert([...args, '--json']);
  const records = (run.stdout || '').trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  return records.pop() ?? { code: 'unreadable', message: (run.stderr || '').trim().slice(0, 300) };
};

const readEnv = () => {
  const values = {};
  for (const file of ['.env.livekit', '.env.local']) {
    const path = join(HOME, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && m[2]) values[m[1]] = m[2]; }
  }
  return values;
};
/** Sets keys in .env.local (0600), keeping every other line as it was. */
function writeEnv(updates) {
  const lines = existsSync(ENV) ? readFileSync(ENV, 'utf8').split('\n').filter(line => line !== '') : [];
  for (const [key, value] of Object.entries(updates)) {
    const at = lines.findIndex(line => line.startsWith(`${key}=`));
    if (at >= 0) lines[at] = `${key}=${value}`; else lines.push(`${key}=${value}`);
  }
  writeFileSync(ENV, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(ENV, 0o600);
}

export async function setup(argv = []) {
  if (!process.stdin.isTTY) fail('setup asks a few questions; run it in a terminal.');
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) fail(`Node 20 or newer is needed (this is ${process.versions.node}).`);
  console.log(c.bold('facetime-me setup') + c.dim('  ·  re-run any time; finished steps are skipped'));

  // 1. Dependencies (the Chert CLI is one of them, pinned in package.json).
  step(1, 'Dependencies');
  if (!existsSync(join(HOME, 'node_modules', '@livekit', 'agents')) || !chertBin()) {
    const run = spawnSync('npm', ['install', '--no-fund', '--no-audit'], { cwd: HOME, stdio: 'inherit' });
    if (run.status !== 0) fail('npm install failed (see above).');
  }
  ok('installed');

  // 2. Chert: sign-in, a line, and your phone verified over iMessage. The CLI's own onboarding does the work.
  step(2, 'Chert line and phone verification');
  let who = chertJson(['whoami']);
  if (who.signed_in && config().projectId && who.project_id !== config().projectId) {
    console.log(`  Chert is signed in to ${who.project_name} (${who.project_id}), but this folder was set up for ${config().projectId}.`);
    if (await yes('Sign in again and pick the project?', true)) { chert(['login'], { stdio: 'inherit' }); who = chertJson(['whoami']); }
  }
  const status = who.signed_in ? chertJson(['onboard', '--status', '--project', who.project_id]) : { code: 'login_required' };
  const done = status.code === 'onboarding_status' && status.status === 'ready';
  if (!done) {
    console.log('  Chert gives your agent a real FaceTime number. A browser page opens: sign in or create an account,');
    console.log('  enter your name and phone, then text the 6-digit code it shows ' + c.bold('from that phone, over iMessage') + '.');
    const demo = argv.includes('--demo') || await yes("Also take Chert's 1-minute demo call at the end?", false);
    const args = ['onboard', '--stack', 'livekit', '--livekit', 'own', '--plan', 'trial'];
    if (!demo) args.push('--skip-demo');
    // With several projects the browser page can't choose one, so name it whenever we already know it.
    if (who.signed_in) args.push('--project', who.project_id);
    if (['expired', 'cancelled', 'completed'].includes(status.status)) args.push('--restart');
    const run = chert(args, { stdio: 'inherit' });
    if (run.status !== 0) fail('Chert onboarding did not finish. Fix what it printed above, then run setup again.');
    who = chertJson(['whoami']);
  }
  if (!who.signed_in) fail('Chert is not signed in. Run setup again.');
  ok(`signed in as ${who.email} · ${who.project_name}`);

  // 3. Remember the project for --listen and for alerts.
  step(3, 'Project');
  writeJson(CONFIG_PATH, { ...config(), projectId: who.project_id });
  ok(`using project ${who.project_id}`);

  // 4. Keys. LiveKit carries the call audio/video; OpenAI Realtime is the voice.
  step(4, 'Keys (saved to .env.local, never shown)');
  let env = readEnv();
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    // On Chert's Shared plan the project owner can get LiveKit keys straight from Chert.
    const provided = chertJson(['livekit']);
    env = readEnv();
    if (env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET) ok('LiveKit keys from Chert');
    else {
      if (provided.code) console.log(c.dim(`  (Chert didn't provide LiveKit keys: ${provided.code})`));
      console.log('  Create a free LiveKit Cloud project at https://cloud.livekit.io → Settings → API keys.');
      const url = await ask('  LIVEKIT_URL (wss://…): ');
      if (!/^wss:\/\//.test(url)) fail('LIVEKIT_URL should start with wss://');
      const key = await ask('  LIVEKIT_API_KEY: ');
      const secret = await ask('  LIVEKIT_API_SECRET (hidden): ', { secret: true });
      if (!key || !secret) fail('both LiveKit keys are needed.');
      writeEnv({ LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret });
      ok('LiveKit keys saved');
    }
  } else ok('LiveKit keys already set');
  if (!readEnv().OPENAI_API_KEY) {
    console.log('  The mascot talks through OpenAI Realtime. Key: https://platform.openai.com/api-keys (usage is billed by OpenAI).');
    const key = await ask('  OPENAI_API_KEY (hidden): ', { secret: true });
    if (!key) fail('an OpenAI key is needed for the voice.');
    writeEnv({ OPENAI_API_KEY: key });
    ok('OpenAI key saved');
  } else ok('OpenAI key already set');

  // 5. Point Chert at those keys and check everything end to end.
  step(5, 'Checking with chert doctor');
  const envFile = ['.env.local', '.env.livekit'].map(name => join(HOME, name)).find(path => existsSync(path) && /^LIVEKIT_URL=/m.test(readFileSync(path, 'utf8')));
  const saved = chertJson(['setup', '--env-file', envFile, '--project', who.project_id]);
  if (saved.code !== 'setup_saved') fail(`chert setup: ${saved.message ?? saved.code}`);
  const doctor = chertJson(['doctor']);
  let number = null;
  for (const check of doctor.checks ?? []) {
    if (check.status === 'skip') continue;
    console.log(`  ${check.status === 'pass' ? c.green('✓') : c.red('✗')} ${check.name.padEnd(10)} ${check.detail}`);
    if (check.name === 'line') number = check.detail.match(/^\(\d{3}\) \d{3}-\d{4}/)?.[0] ?? null;
  }
  // A busy line (another listener, or a call in progress) is not a setup problem.
  const blocking = (doctor.checks ?? []).filter(check => check.status === 'fail' && check.name !== 'line_free');
  if (blocking.length) fail('fix the ✗ above (chert guide fix explains each code), then run setup again.');
  writeJson(CONFIG_PATH, { ...config(), ...(number ? { lineNumber: number } : {}) });

  // 6. Optional: Claude Code hooks, so the mascot FaceTimes you when a command fails or Claude Code is stuck.
  step(6, 'Optional: let the mascot call you when Claude Code needs you');
  if (await yes('Install Claude Code hooks for this?', false)) await installAlerts();
  else ok('skipped (run setup again to add it later)');

  linkCommand();
  console.log(`\n${c.bold('All set.')} Start it with:\n\n    ${c.bold('facetime-me --listen')}\n\nthen FaceTime ${c.bold(number ?? 'your Chert line')} from your iPhone, iPad or Mac.\n`);
}

async function installAlerts() {
  const current = config();
  const phone = await ask(`  Your phone number, as verified with Chert (+1…)${current.phone ? ` [${current.phone}]` : ''}: `, { fallback: current.phone ?? '' });
  if (!/^\+\d{8,15}$/.test(phone)) fail('use the full number with country code, like +14155550123.');
  writeJson(CONFIG_PATH, { ...config(), phone });
  if (!readEnv().CHERT_API_KEY) {
    console.log(`  Outbound calls use a project API key: https://app.trychert.com/developer (owner only).`);
    const key = await ask('  CHERT_API_KEY (ftk_…, hidden): ', { secret: true });
    if (!key.startsWith('ftk_')) fail('that is not a Chert project key (they start with ftk_).');
    writeEnv({ CHERT_API_KEY: key });
  }
  const path = join(homedir(), '.claude', 'settings.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (existsSync(path)) copyFileSync(path, `${path}.bak-facetime-me`);
  const hook = { type: 'command', command: BIN, async: true };
  const wanted = [['PostToolUseFailure', 'Bash'], ['StopFailure', undefined], ['Notification', 'permission_prompt|elicitation_dialog|agent_needs_input']];
  settings.hooks ??= {};
  for (const [event, matcher] of wanted) {
    const list = settings.hooks[event] ??= [];
    if (list.some(entry => (entry.hooks ?? []).some(h => String(h.command).includes('facetime-me')))) continue;
    list.push(matcher ? { matcher, hooks: [hook] } : { hooks: [hook] });
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  rmSync(join(STATE, 'off'), { force: true });
  ok(`hooks added to ${path} (backup: settings.json.bak-facetime-me). Pause anytime: facetime-me --off`);
}

/** Puts `facetime-me` on PATH with npm link; if that needs sudo, says how to run it instead. */
function linkCommand() {
  const which = spawnSync('sh', ['-c', 'command -v facetime-me'], { encoding: 'utf8' });
  if (which.status === 0) return;
  const link = spawnSync('npm', ['link', '--no-fund', '--no-audit'], { cwd: HOME, encoding: 'utf8' });
  if (link.status === 0) return ok('`facetime-me` is now a command in every terminal');
  console.log(c.dim(`  Couldn't add facetime-me to PATH (npm link failed). Use: node ${BIN} --listen, or add an alias.`));
}

if (process.argv[1] && process.argv[1].endsWith('setup.mjs')) await setup(process.argv.slice(2));

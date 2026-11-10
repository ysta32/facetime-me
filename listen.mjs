// facetime-me --listen: one command, any terminal. Checks the Chert sign-in, starts the mascot
// agent, connects it to the line with `chert dev`, and keeps both up until Ctrl+C.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_NAME, HOME, STATE, config } from './lib.mjs';

// The env file holding the LiveKit keys: setup writes .env.local; older installs kept them in .env.livekit.
const ENV_FILE = ['.env.local', '.env.livekit'].map(name => join(HOME, name)).find(path => existsSync(path) && /^LIVEKIT_URL=/m.test(readFileSync(path, 'utf8'))) ?? join(HOME, '.env.local');
const PID_FILE = join(STATE, 'listen.pid');
const AGENT_LOG = join(STATE, 'agent-listen.log');
const DEV_LOG = join(STATE, 'chert-dev-listen.log');
export const CHERT = [join(HOME, 'node_modules', '.bin', 'chert'), join(homedir(), '.npm-global', 'bin', 'chert'), '/usr/local/bin/chert', '/opt/homebrew/bin/chert'].find(existsSync) ?? 'chert';

const say = (text) => console.log(`facetime-me · ${text}`);
const die = (text, code = 1) => { console.error(`facetime-me · ${text}`); process.exit(code); };
const chertJson = (args) => {
  const run = spawnSync(CHERT, [...args, '--json'], { encoding: 'utf8' });
  try { return JSON.parse(run.stdout.trim().split('\n').pop()); } catch { return { code: 'unreadable', message: (run.stderr || run.stdout || '').trim() }; }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function listen() {
  // One listener at a time: a second `chert dev` would fight the first for the line.
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, 'utf8'));
    if (pid && alive(pid)) die(`already listening in another terminal (pid ${pid}). Ctrl+C there first.`, 4);
    rmSync(PID_FILE, { force: true });
  }
  if (!existsSync(ENV_FILE) || !config().projectId) die('not set up yet. Run: facetime-me --setup', 3);
  const PROJECT = config().projectId;

  // 1. Sign-in, on the right project. Only opens the browser when it has to.
  let who = chertJson(['whoami']);
  if (!who.signed_in || who.project_id !== PROJECT) {
    say(who.signed_in ? `Chert is signed in to another project (${who.project_id}); approve ${PROJECT} in the browser.` : 'Chert needs you to sign in once (lasts 30 days).');
    spawnSync(CHERT, ['login'], { stdio: 'inherit' });
    who = chertJson(['whoami']);
    if (who.project_id !== PROJECT) die(`still not signed in to project ${PROJECT}. Run \`chert login\` and choose it.`, 3);
  }
  const saved = chertJson(['setup', '--env-file', ENV_FILE, '--project', PROJECT]);
  if (saved.code !== 'setup_saved') die(`chert setup failed: ${saved.message ?? saved.code}`);
  say(`signed in as ${who.email} · ${who.project_name}`);

  writeFileSync(PID_FILE, String(process.pid));
  const children = [];
  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    say('stopping, freeing the line…');
    // chert dev first, with SIGINT, so it releases the line cleanly; then the agent.
    for (const child of [...children].reverse()) if (child.exitCode === null) child.kill('SIGINT');
    setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); rmSync(PID_FILE, { force: true }); process.exit(code); }, 4000).unref();
    Promise.all(children.map(child => child.exitCode !== null ? null : new Promise(resolve => child.once('exit', resolve))))
      .then(() => { rmSync(PID_FILE, { force: true }); process.exit(code); });
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  process.on('SIGHUP', () => stop(0));

  // 2. The agent. Ready once LiveKit has registered the worker.
  say('starting the mascot agent…');
  const agentLog = openSync(AGENT_LOG, 'w', 0o600);
  const agent = spawn(process.execPath, [join(HOME, 'agent.mjs'), 'start'], { cwd: HOME, stdio: ['ignore', agentLog, agentLog] });
  children.push(agent);
  agent.on('exit', code => { if (!stopping) { say(`the agent stopped (exit ${code}). Log: ${AGENT_LOG}`); stop(1); } });
  const deadline = Date.now() + 45000;
  while (!readFileSync(AGENT_LOG, 'utf8').includes('"registered worker"')) {
    if (stopping) return;
    if (Date.now() > deadline) { say(`the agent did not register with LiveKit in 45 s. Log: ${AGENT_LOG}`); return stop(1); }
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  // 3. Connect it to the line and relay what matters.
  say('connecting to your Chert line…');
  const dev = spawn(CHERT, ['dev', '--agent', AGENT_NAME, '--json'], { cwd: HOME, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(dev);
  const devLog = openSync(DEV_LOG, 'w', 0o600);
  let line = null, buffer = '';
  dev.stdout.on('data', chunk => {
    writeFileSync(devLog, chunk);
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let record; try { record = JSON.parse(raw); } catch { continue; }
      if (record.code === 'dev_ready') line = record.line;
      else if (record.code === 'agent_warm') say(`ready. FaceTime ${line ?? 'your line'} to talk to the mascot. Ctrl+C to stop.`);
      else if (record.code === 'runtime_observation' || record.code === 'line_state' || record.code === 'dev_connected') continue;
      else if (/call/.test(record.code ?? '')) say(record.message ?? record.code);
      else if (record.ok === false || record.action) say(`${record.message ?? record.code}${record.action ? ` → ${record.action}` : ''}`);
    }
  });
  dev.stderr.on('data', chunk => writeFileSync(devLog, chunk));
  dev.on('exit', code => { if (!stopping) { say(`chert dev stopped (exit ${code}). Log: ${DEV_LOG}`); stop(code || 1); } });
}

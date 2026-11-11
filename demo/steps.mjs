// The demo's work after each yes on the call. Every step really happens in demo/acme-web (search, read,
// write, build, test, commit, push to a local remote, deploy script), and is printed as the same
// stream-json Claude Code emits, so the mascot shows each tool live. The terminal window gets a copy
// through the demo feed ("term" lines).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [stage, folder, feed] = process.argv.slice(2);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const term = text => { try { appendFileSync(feed, `term ${JSON.stringify(text)}\n`); } catch { /* optional */ } };
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
let n = 0;

/** One tool call: shown on the call and in the terminal, then its real result. */
async function tool(name, input, run, { hold = 1700, label } = {}) {
  const id = `demo_${stage}_${n++}`;
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  term(`tool ${label ?? `${name}(${input.command ?? input.pattern ?? input.file_path?.replace(`${folder}/`, '') ?? ''})`}`);
  const startedAt = Date.now();
  const output = String(await run() ?? '');
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } });
  if (output.trim()) term(`out ${output.trimEnd()}`);
  await sleep(Math.max(0, hold - (Date.now() - startedAt)));
  return output;
}
const sh = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: folder, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } }); return { ok: r.status === 0, text: `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '').trim() }; };
const git = (...args) => sh('git', ['-c', 'user.name=Claude', '-c', 'user.email=claude@acme-web.dev', '-c', 'commit.gpgsign=false', ...args]);
const done = (ok, result) => { emit({ type: 'result', is_error: !ok, result }); process.exit(ok ? 0 : 1); };

if (stage === 'fix') {
  await tool('Grep', { pattern: 'AUTH_SECRET' }, () => sh('grep', ['-rn', 'AUTH_SECRET', 'src']).text, { hold: 1800 });
  await tool('Read', { file_path: join(folder, 'src', 'auth.ts') }, () => readFileSync(join(folder, 'src', 'auth.ts'), 'utf8').split('\n').slice(11, 16).join('\n'), { hold: 2000 });
  const secret = randomBytes(24).toString('hex');
  await tool('Write', { file_path: join(folder, '.env.local'), content: `AUTH_SECRET=${secret.slice(0, 12)}…` }, () => { writeFileSync(join(folder, '.env.local'), `AUTH_SECRET=${secret}\n`, { mode: 0o600 }); return 'Wrote .env.local (git-ignored)'; }, { hold: 2000 });
  await tool('Write', { file_path: join(folder, '.env.example'), content: 'AUTH_SECRET=   # 32+ random characters' }, () => { writeFileSync(join(folder, '.env.example'), 'AUTH_SECRET=   # 32+ random characters\n'); return 'Documented it in .env.example'; }, { hold: 1600 });
  const build = await tool('Bash', { command: 'npm run build' }, () => sh('npm', ['run', 'build', '--silent']).text, { hold: 2000 });
  const tests = await tool('Bash', { command: 'npm test' }, () => { const r = sh('npm', ['test', '--silent']); return r.text.split('\n').map(l => l.trim().replace(/\s*\([\d.]+ms\)$/, '')).filter(l => /^[✔✖]|^ℹ (pass|fail) /.test(l)).join('\n'); }, { hold: 2600 });
  done(/built in/.test(build) && /pass 12/.test(tests) && /fail 0/.test(tests), 'Added AUTH_SECRET to .env.local; build passes and 12 tests pass.');
}
if (stage === 'push') {
  git('add', '-A');
  await tool('Bash', { command: 'git commit -m "fix(auth): load AUTH_SECRET from .env.local"' }, () => git('commit', '-m', 'fix(auth): load AUTH_SECRET from .env.local').text.split('\n')[0], { hold: 2200 });
  const push = await tool('Bash', { command: 'git push origin main' }, () => git('push', 'origin', 'main').text.split('\n').filter(l => /->|main/.test(l)).join('\n') || 'pushed', { hold: 2200 });
  done(/main/.test(push), 'Committed and pushed to main.');
}
if (stage === 'deploy') {
  const out = await tool('Bash', { command: 'npm run deploy' }, () => sh('npm', ['run', 'deploy', '--silent']).text, { hold: 2600 });
  done(/Live at/.test(out), 'Live on staging.');
}
done(false, `unknown stage ${stage}`);

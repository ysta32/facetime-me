// The demo's fix: adds the missing variable with a throwaway local value, then really re-runs the build.
// It prints the same stream-json events Claude Code does, so the mascot on the call follows each step.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const folder = process.argv[2];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tool = (name, input) => process.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })}\n`);

tool('Read', { file_path: join(folder, 'src', 'auth.ts') });
readFileSync(join(folder, 'src', 'auth.ts'));
await sleep(1600);

tool('Write', { file_path: join(folder, '.env.local') });
writeFileSync(join(folder, '.env.local'), `AUTH_SECRET=${randomBytes(24).toString('hex')}\n`, { mode: 0o600 });
await sleep(1600);

tool('Bash', { command: 'npm run build' });
const build = spawnSync('npm', ['run', 'build', '--silent'], { cwd: folder, encoding: 'utf8' });
writeFileSync(join(folder, '.build.log'), build.stdout + build.stderr);
const ok = build.status === 0;
process.stdout.write(`${JSON.stringify({ type: 'result', is_error: !ok, result: ok ? 'Added AUTH_SECRET to .env.local; the build passes.' : 'The build still fails.' })}\n`);
process.exit(build.status ?? 1);

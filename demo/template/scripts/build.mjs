// A small fake build: compiles a few "modules", then fails exactly like a real missing env var does.
import { existsSync, readFileSync } from 'node:fs';

const red = text => `\x1b[1;31m${text}\x1b[0m`, green = text => `\x1b[32m${text}\x1b[0m`, dim = text => `\x1b[2m${text}\x1b[0m`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

console.log(dim('vite v6.2.1 building for production...'));
await pause(350);
console.log(`${green('✓')} 214 modules transformed.`);
await pause(250);

const env = existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : '';
if (!/^AUTH_SECRET=.+/m.test(env)) {
  console.error('');
  console.error(red('✗ Build failed in src/auth.ts:14:27'));
  console.error(red('  Error: Missing required environment variable AUTH_SECRET'));
  console.error('');
  console.error('    13 | export const session = createSession({');
  console.error('  > 14 |   secret: requireEnv("AUTH_SECRET"),');
  console.error('    15 |   maxAge: 60 * 60 * 24,');
  console.error('');
  process.exit(1);
}
console.log(`${green('✓')} built in 1.21s`);

// A stand-in deploy: real enough to watch, touches nothing outside this folder.
const green = t => `\x1b[32m${t}\x1b[0m`, dim = t => `\x1b[2m${t}\x1b[0m`;
const pause = ms => new Promise(r => setTimeout(r, ms));
console.log(dim('Deploying acme-web@1.4.3 to staging…'));
await pause(700);
console.log(`${green('✓')} Uploaded build (214 files, 1.8 MB)`);
await pause(800);
console.log(`${green('✓')} Health check passed`);
await pause(500);
console.log(`${green('✓')} Live at https://staging.acme-web.dev`);

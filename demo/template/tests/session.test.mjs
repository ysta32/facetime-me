import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { loadEnvFile, sessionExpiry } from '../src/env.mjs';

test('sessions last a day', () => assert.equal(sessionExpiry(new Date(0), 86400).toISOString(), '1970-01-02T00:00:00.000Z'));
test('rejects a zero maxAge', () => assert.throws(() => sessionExpiry(new Date(0), 0)));
test('AUTH_SECRET is configured for local builds', () => {
  const env = existsSync('.env.local') ? loadEnvFile(readFileSync('.env.local', 'utf8')) : {};
  assert.ok((env.AUTH_SECRET ?? '').length >= 32, 'AUTH_SECRET missing from .env.local');
});

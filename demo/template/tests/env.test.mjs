import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvFile, requireEnv } from '../src/env.mjs';

test('requireEnv returns a set variable', () => assert.equal(requireEnv('A', { A: 'x' }), 'x'));
test('requireEnv throws on a missing variable', () => assert.throws(() => requireEnv('A', {}), /Missing required environment variable A/));
test('requireEnv throws on an empty variable', () => assert.throws(() => requireEnv('A', { A: '' })));
test('loadEnvFile reads KEY=value lines', () => assert.deepEqual(loadEnvFile('A=1\nB=two'), { A: '1', B: 'two' }));
test('loadEnvFile strips quotes', () => assert.equal(loadEnvFile('A="hi"').A, 'hi'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookie } from '../src/env.mjs';

test('parses one cookie', () => assert.deepEqual(parseCookie('sid=abc'), { sid: 'abc' }));
test('parses several cookies', () => assert.deepEqual(parseCookie('a=1; b=2'), { a: '1', b: '2' }));
test('decodes values', () => assert.equal(parseCookie('n=hello%20world').n, 'hello world'));
test('handles an empty header', () => assert.deepEqual(parseCookie(''), {}));

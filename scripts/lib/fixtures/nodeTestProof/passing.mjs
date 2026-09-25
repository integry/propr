import assert from 'node:assert/strict';
import { test } from 'node:test';

test('first passing test', () => assert.equal(1 + 1, 2));
test('second passing test', () => assert.ok(true));

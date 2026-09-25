import assert from 'node:assert/strict';
import { test } from 'node:test';

test('passing neighbour', () => assert.ok(true));
test('failing assertion', () => assert.equal(1, 2));

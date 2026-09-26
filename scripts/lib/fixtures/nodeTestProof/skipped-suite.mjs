import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

test('remaining passing test', () => assert.ok(true));
describe('skipped required suite', { skip: 'not on this platform' }, () => {
    test('suppressed required test', () => assert.ok(true));
});

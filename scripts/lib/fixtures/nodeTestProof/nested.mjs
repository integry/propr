import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('outer suite', () => {
    test('outer test', () => assert.ok(true));
    describe('inner suite', () => {
        test('inner test', () => assert.ok(true));
    });
});

test('parent test', async (t) => {
    await t.test('subtest', () => assert.ok(true));
});

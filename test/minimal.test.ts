import { test } from 'node:test';
import assert from 'node:assert';

test('Minimal test without @propr/core imports', () => {
    console.log('Running minimal test');
    assert.strictEqual(1 + 1, 2);
    console.log('Minimal test completed');
});

test('Another minimal test', () => {
    assert.ok(true, 'This should pass');
});
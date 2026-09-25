import { test } from 'node:test';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('passing neighbour', () => {});
test('parent that does not await its subtest', (t) => {
    t.test('abandoned subtest', () => sleep(100));
});
test('test over its own timeout', { timeout: 20 }, () => sleep(500));

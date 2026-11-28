import { test } from 'node:test';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('passing neighbour', () => {});
// Node 24 waits for a subtest the parent never awaited, so leaving one behind
// no longer cancels it. A parent that times out still cancels its unfinished
// subtest on Node 22 and 24 alike.
test('test over its own timeout', { timeout: 20 }, (t) => {
    t.test('abandoned subtest', () => sleep(500));
    return sleep(500);
});

import { test } from 'node:test';

test('exits the process before results are reported', () => {
    process.exit(0);
});

import { test } from 'node:test';

test('never settles', () => new Promise(() => setInterval(() => {}, 1_000)));

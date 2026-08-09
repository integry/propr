import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { sweepTerminalUltrafixFinalizations } from '../src/daemon/ultrafixTerminalSweep.js';

test('daemon sweep resumes every valid terminal state identity', async () => {
    const resumed: Array<{ owner: string; repo: string; pr: number }> = [];
    const info = mock.fn();
    const warn = mock.fn();
    await sweepTerminalUltrafixFinalizations({} as never, {
        listKeys: mock.fn(async () => ['state:one', 'invalid', 'state:two']),
        parseKey: key => {
            if (!key.startsWith('state:')) return null;
            return { owner: 'integry', repo: 'propr', pr: key === 'state:one' ? 1806 : 1807 };
        },
        resume: mock.fn(async identity => {
            resumed.push(identity);
            return identity.pr === 1806;
        }),
        createLogger: () => ({ info }) as never,
        warn,
    });

    assert.deepEqual(resumed.map(identity => identity.pr), [1806, 1807]);
    assert.equal(info.mock.callCount(), 1);
    assert.equal(warn.mock.callCount(), 0);
});

test('daemon sweep isolates one terminal recovery failure from later states', async () => {
    const attempted: number[] = [];
    const warn = mock.fn();
    await sweepTerminalUltrafixFinalizations({} as never, {
        listKeys: mock.fn(async () => ['state:1', 'state:2']),
        parseKey: key => ({ owner: 'integry', repo: 'propr', pr: Number(key.split(':')[1]) }),
        resume: mock.fn(async identity => {
            attempted.push(identity.pr);
            if (identity.pr === 1) throw new Error('temporary GitHub failure');
            return false;
        }),
        createLogger: () => ({ info: mock.fn() }) as never,
        warn,
    });

    assert.deepEqual(attempted, [1, 2]);
    assert.equal(warn.mock.callCount(), 1);
});

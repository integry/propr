import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

await mock.module('@propr/core', {
    namedExports: {
        db: () => { throw new Error('the sweep test injects its candidates'); },
        generateCorrelationId: () => 'corr',
        logger: { warn() {}, info() {}, debug() {}, error() {} },
        PlanIssueStatus: { MERGED: 'merged', CLOSED: 'closed' },
        reevaluatePRAutoMerge: async () => undefined,
    },
});

const { sweepAutoMergeCandidates } = await import('../src/daemon/autoMergeSweep.js');

test('the sweep re-evaluates every open plan PR through the merge gates', async () => {
    const reevaluate = mock.fn(async (owner: string, _repo: string, _pr: number) => {
        if (owner === 'broken') throw new Error('GitHub down');
    });
    await sweepAutoMergeCandidates(
        async () => [
            { repository: 'integry/agent-tank-website', prNumber: 43 },
            { repository: 'broken/repo', prNumber: 1 },
            { repository: 'not-a-repository', prNumber: 2 },
            { repository: 'integry/forex', prNumber: 703 },
        ],
        reevaluate as never,
    );
    // One PR failing does not stop the rest; malformed repositories are skipped.
    assert.deepEqual(reevaluate.mock.calls.map(call => call.arguments.slice(0, 3)), [
        ['integry', 'agent-tank-website', 43],
        ['broken', 'repo', 1],
        ['integry', 'forex', 703],
    ]);
});

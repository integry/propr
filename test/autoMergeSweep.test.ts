import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

await mock.module('@propr/core', {
    namedExports: {
        db: () => { throw new Error('the sweep test injects its candidates'); },
        generateCorrelationId: () => 'corr',
        logger: { warn() {}, info() {}, debug() {}, error() {} },
        PlanIssueStatus: { MERGED: 'merged', CLOSED: 'closed' },
        reevaluatePRAutoMerge: async () => undefined,
        loadDeferredUpToDateCandidates: async () => [],
        settleDeferredUpToDateCandidate: async () => undefined,
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
        { load: async () => [], settle: async () => undefined },
    );
    // One PR failing does not stop the rest; malformed repositories are skipped.
    assert.deepEqual(reevaluate.mock.calls.map(call => call.arguments.slice(0, 3)), [
        ['integry', 'agent-tank-website', 43],
        ['broken', 'repo', 1],
        ['integry', 'forex', 703],
    ]);
});

test('the sweep retries require_up_to_date deferrals, plan PRs or not, and settles them only after a re-evaluation', async () => {
    const reevaluate = mock.fn(async (owner: string) => {
        if (owner === 'flaky') throw new Error('GitHub down');
    });
    const settled: Array<[string, number]> = [];
    await sweepAutoMergeCandidates(
        async () => [{ repository: 'integry/propr', prNumber: 7 }],
        reevaluate as never,
        {
            load: async () => [
                { repository: 'integry/propr', prNumber: 7, deferredAt: 1 },
                { repository: 'integry/propr', prNumber: 12, deferredAt: 2 },
                { repository: 'flaky/repo', prNumber: 3, deferredAt: 3 },
            ],
            settle: async candidate => { settled.push([candidate.repository, candidate.prNumber]); },
        },
    );
    // A plan PR that is also deferred is evaluated once; the non-plan PR 12 is evaluated too.
    assert.deepEqual(reevaluate.mock.calls.map(call => call.arguments.slice(0, 3)), [
        ['integry', 'propr', 7],
        ['integry', 'propr', 12],
        ['flaky', 'repo', 3],
    ]);
    // A failed re-evaluation keeps its retry entry.
    assert.deepEqual(settled, [['integry/propr', 7], ['integry/propr', 12]]);
});

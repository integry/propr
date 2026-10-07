import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

let enabled = true;
let head = 'head';
let state = 'open';
let checks: unknown[] = [];
let statuses: unknown[] = [];
const posted: Array<{ evidence: { source: string; sha: string } }> = [];
const paginate = mock.fn(async (route: string) => route.endsWith('/check-runs') ? checks : statuses);
await mock.module('../packages/core/src/auth/githubAuth.js', { namedExports: {
    getAuthenticatedOctokit: async () => ({ paginate, request: async () => ({ data: { state, head: { sha: head } } }) }),
} });
await mock.module('../packages/core/src/daemon/configLoader.js', { namedExports: {
    isAutoCiFollowupEnabledForRepository: async () => enabled,
    getNonBlockingChecksForRepository: async () => ['optional*'],
} });
await mock.module('../packages/core/src/webhook/ciFailureFollowup.js', { namedExports: {
    isFailingCheckRunConclusion: (value: string) => ['failure', 'timed_out'].includes(value),
    postCiFailureFollowup: async (request: typeof posted[number]) => { posted.push(request); },
} });
const { recoverCiFailureFollowups } = await import('../packages/core/src/webhook/ciFailureRecovery.js');

function check(name: string, conclusion = 'failure') {
    return { id: 1, name, status: 'completed', conclusion, output: { summary: 'failure details' } };
}
beforeEach(() => {
    enabled = true; head = 'head'; state = 'open'; checks = []; statuses = []; posted.length = 0;
    paginate.mock.resetCalls();
});
test('recovers blocking failures using the same identity as webhook delivery', async () => {
    checks = [check('build'), check('optional suite'), check('passed', 'success')];
    statuses = [
        { context: 'legacy', state: 'success' },
        { context: 'legacy', state: 'failure' },
        { context: 'deploy', state: 'error' },
    ];
    await recoverCiFailureFollowups('o', 'r', 1, 'head');
    assert.deepEqual(posted.map(p => p.evidence.source), ['check-run:build', 'status:deploy']);
    assert.ok(posted.every(p => p.evidence.sha === 'head'));
});
test('does not recover failures for a replaced head or closed PR', async () => {
    checks = [check('build')];
    head = 'replacement';
    await recoverCiFailureFollowups('o', 'r', 1, 'head');
    head = 'head'; state = 'closed';
    await recoverCiFailureFollowups('o', 'r', 1, 'head');
    assert.equal(posted.length, 0);
});
test('disabled automation makes no GitHub requests', async () => {
    enabled = false;
    await recoverCiFailureFollowups('o', 'r', 1, 'head');
    assert.equal(paginate.mock.callCount(), 0);
});

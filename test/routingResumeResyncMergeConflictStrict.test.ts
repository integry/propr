import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert';
import { closeConnection } from '../packages/core/src/db/connection.js';

// Strict merge-conflict catch-up: one uncertain open PR (failed prime read,
// failed evaluation, unknown mergeability, failed task lookup) fails the family
// instead of being logged and skipped, and every open PR is evaluated rather
// than one rotating page. The periodic sweep keeps its tolerant behavior.

after(async () => {
    await closeConnection();
});

async function mockModule(specifier: string, overrides: Record<string, unknown>): Promise<void> {
    const real = await import(specifier) as Record<string, unknown>;
    await mock.module(specifier, { namedExports: { ...real, ...overrides } });
}

type FakePr = { number: number; state: string; draft: boolean; mergeable: boolean | null; mergeable_state?: string; labels: Array<{ name: string }>; head: { ref: string; sha: string; repo: object }; base: { ref: string; sha: string } };
const prs = new Map<number, FakePr>();
const failingReads = new Set<number>();
const queued: Array<Record<string, unknown>> = [];

function pr(number: number, overrides: Partial<FakePr> = {}): FakePr {
    return {
        number, state: 'open', draft: false, mergeable: true, labels: [{ name: 'AI' }],
        head: { ref: `feature-${number}`, sha: `h${number}`, repo: {} }, base: { ref: 'main', sha: 'b1' }, ...overrides,
    };
}

const octokit = {
    paginate: async () => [...prs.values()].map(value => ({ number: value.number })),
    request: async (endpoint: string, params: { pull_number?: number; page?: number }) => {
        if (endpoint === 'GET /repos/{owner}/{repo}/pulls') return { data: params.page === 1 ? [...prs.values()].slice(0, 30).map(value => ({ number: value.number })) : [] };
        const number = params.pull_number as number;
        if (failingReads.has(number)) throw Object.assign(new Error(`GitHub 502 reading #${number}`), { status: 502 });
        return { data: prs.get(number) };
    },
};

await mockModule('../packages/core/src/auth/githubAuth.js', { getAuthenticatedOctokit: async () => octokit });
await mockModule('../packages/core/src/config/configManager.js', { loadValidTriggerLabels: async () => ['AI'] });
await mockModule('../packages/core/src/queue/taskQueue.js', {
    getIssueQueue: async () => ({ add: async (_name: string, data: Record<string, unknown>) => { queued.push(data); } }),
});

const { evaluateOpenPullRequests } = await import('../packages/core/src/webhook/mergeConflictAutoResolve.js');
const { runResyncGeneration } = await import('./helpers/resumeResyncHarness.js');

const redisClient = {
    get: async () => null,
    set: async () => 'OK',
    eval: async () => 'reserved',
} as never;
const setting = { enabled: true, source: 'repository' } as never;
const deps = { sleep: async () => undefined, pollDelaysMs: [] as number[], hasTaskForPullRequest: async () => true };

function evaluate(strict: boolean, overrides: Record<string, unknown> = {}) {
    return evaluateOpenPullRequests({
        owner: 'acme', repoName: 'widgets', trigger: 'sweep', redisClient, correlationId: 'resync', setting, deps, strict, ...overrides,
    });
}

beforeEach(() => {
    prs.clear(); failingReads.clear(); queued.length = 0;
    prs.set(1, pr(1, { mergeable: false, mergeable_state: 'dirty' }));
    prs.set(2, pr(2));
});

test('a strict evaluation queues conflicts and reports every PR it decided', async () => {
    const results = await evaluate(true);
    assert.deepEqual(results.map(result => [result.prNumber, result.outcome]), [[1, 'queued'], [2, 'skipped']]);
    assert.deepEqual(queued.map(job => job.pullRequestNumber), [1]);
});

test('a failed read of one PR fails a strict evaluation; the periodic sweep logs and continues', async () => {
    failingReads.add(2);
    assert.equal((await evaluate(false)).length, 1, 'tolerant: PR #2 is skipped after a logged error');
    await assert.rejects(evaluate(true), /GitHub 502 reading #2/);
});

test('unknown mergeability and a failed task lookup are uncertain, not "clean" or "not ProPR"', async () => {
    prs.set(2, pr(2, { mergeable: null }));
    assert.deepEqual((await evaluate(false)).map(result => result.outcome), ['queued', 'skipped']);
    await assert.rejects(evaluate(true), /Mergeability of acme\/widgets#2 is still unknown/);

    prs.set(2, pr(2, { labels: [] }));
    const lookupFails = { ...deps, hasTaskForPullRequest: async () => { throw new Error('sqlite busy'); } };
    assert.equal((await evaluate(false, { deps: lookupFails })).length, 2);
    await assert.rejects(evaluate(true, { deps: lookupFails }), /sqlite busy/);
});

test('strict evaluation covers every open PR, not one rotating page', async () => {
    prs.clear();
    for (let number = 1; number <= 45; number++) prs.set(number, pr(number));
    assert.equal((await evaluate(false)).length, 30);
    assert.equal((await evaluate(true)).length, 45);
});

test('one uncertain open PR keeps merge_conflicts from completing the generation', async () => {
    failingReads.add(2);
    const result = await runResyncGeneration({ steps: { merge_conflicts: async () => { await evaluate(true); } } });
    assert.equal(result.state, 'failed');
    assert.deepEqual(result.completions, []);
    assert.match(result.lastError ?? '', /merge_conflicts: GitHub 502 reading #2/);
});

import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert';
import type { Redis } from 'ioredis';

// The daemon's executable matrix: which strict path each family takes for a
// configured, an inaccessible and an unconfigured repository.

const real = await import('@propr/core') as Record<string, unknown> & typeof import('@propr/core');
const calls: string[] = [];
let referenced: string[] = [];
await mock.module('@propr/core', { namedExports: {
    ...real,
    reconcileTaskIntents: async (_redis: unknown, repositories: string[], options: { strict?: boolean }) => {
        calls.push(`reconcileTaskIntents:${repositories.join(',')}:${String(options.strict)}`);
    },
    invalidateRepositoryIntents: async (_redis: unknown, repository: string) => {
        calls.push(`invalidateRepositoryIntents:${repository}`);
        return { cancelled: 0, retainedCleanups: 0 };
    },
    settleWithdrawalCleanups: async (_redis: unknown, matches: (target: { repoOwner: string; repoName: string }) => boolean) => {
        calls.push(`settleWithdrawalCleanups:${String(matches({ repoOwner: 'acme', repoName: 'moved' }))}`);
        return { idle: false };
    },
    listIntentRepositories: async () => referenced,
    fetchIssuesForRepo: async (_octokit: unknown, repository: string, _correlationId: string, options: { throwOnError?: boolean }) => {
        calls.push(`fetchIssuesForRepo:${repository}:${String(options.throwOnError)}`);
        return [{ number: 1 }];
    },
    processDetectedIssue: async (_issue: unknown, _correlationId: string, _redis: unknown, options: { strict?: boolean }) => {
        calls.push(`processDetectedIssue:${String(options?.strict)}`);
        return { status: 'accepted' };
    },
    sweepConflictedPullRequests: async (options: { repositories: string[]; strict?: boolean }) => {
        calls.push(`sweepConflictedPullRequests:${options.repositories.join(',')}:${String(options.strict)}`);
        return [];
    },
} });

const realPolling = await import('../src/polling/prCommentPolling.js') as Record<string, unknown>;
await mock.module('../src/polling/prCommentPolling.js', { namedExports: {
    ...realPolling,
    pollForPullRequestComments: async (_octokit: unknown, repository: string, _correlationId: string, options: { createdSince?: string; throwOnError?: boolean }) => {
        calls.push(`pollForPullRequestComments:${repository}:${String(options.createdSince)}:${String(options.throwOnError)}`);
    },
} });

const { createResumeResyncReconciler, createRoutingResumeResync, resolveResumeResyncInstallationId } = await import('../src/daemon/routingResumeResync.js');

after(async () => {
    await real.closeConnection();
});

beforeEach(() => {
    calls.length = 0;
    referenced = [];
});

const baseDeps = {
    redisClient: {} as Redis,
    PR_FOLLOWUP_TRIGGER_KEYWORDS: [],
    MODEL_LABEL_PATTERN: '^llm-(.+)$',
    getOctokit: async () => ({}) as never,
};

function stepContext(repository: string, overrides: { access?: 'accessible' | 'inaccessible' | null; configured?: boolean } = {}) {
    const [owner, repo] = repository.split('/');
    return {
        repository, owner, repo, gapStartedAt: '2026-10-10T00:00:00.000Z', gapEndedAt: '2026-10-12T00:00:00.000Z',
        recoveryStartedAt: '2026-10-10T00:00:00.000Z',
        access: 'accessible' as const, configured: true, correlationId: 'test', signal: new AbortController().signal, ...overrides,
    };
}

function step(family: string, deps: Partial<Parameters<typeof createResumeResyncReconciler>[0]> = {}) {
    const found = createResumeResyncReconciler({ ...baseDeps, ...deps }).repositorySteps.find(item => item.family === family);
    assert.ok(found, family);
    return found;
}

test('the daemon matrix implements every reconciliation family in order', async () => {
    referenced = ['acme/legacy'];
    const reconciler = createResumeResyncReconciler({ ...baseDeps, listRepositories: () => ['acme/api'] });
    assert.deepEqual(reconciler.repositorySteps.map(item => item.family), [...real.RESYNC_REPOSITORY_FAMILIES]);
    assert.deepEqual(reconciler.installationSteps.map(item => item.family), [...real.RESYNC_INSTALLATION_FAMILIES]);
    assert.deepEqual(await reconciler.listRepositories(), ['acme/api']);
    assert.deepEqual(await reconciler.listReferencedRepositories(), ['acme/legacy'], 'durable local work is part of the repository set');
});

test('repository access is recorded as state: a 404 is inaccessible; a 403 (suspension or limit) retries', async () => {
    let status: number | null = 404;
    const getOctokit = async () => ({
        request: async () => { if (status !== null) throw Object.assign(new Error(`HTTP ${status}`), { status }); return { data: {} }; },
    }) as never;
    const access = step('repository_access', { getOctokit });
    assert.deepEqual(await access.run(stepContext('acme/gone', { access: null })), { access: 'inaccessible' });
    status = null;
    assert.deepEqual(await access.run(stepContext('acme/api', { access: null })), { access: 'accessible' });
    status = 403;
    await assert.rejects(access.run(stepContext('acme/gone', { access: null })), /HTTP 403/);
});

test('task_intents checks GitHub only for configured, accessible repositories and invalidates locally otherwise', async () => {
    const intents = step('task_intents');
    await intents.run(stepContext('acme/api'));
    await intents.run(stepContext('acme/gone', { access: 'inaccessible' }));
    await intents.run(stepContext('acme/moved', { configured: false }));
    assert.deepEqual(calls, [
        'reconcileTaskIntents:acme/api:true',
        'invalidateRepositoryIntents:acme/gone',
        'invalidateRepositoryIntents:acme/moved',
        'settleWithdrawalCleanups:true',
    ], 'an inaccessible repository keeps its retained cleanups; an accessible unconfigured one settles them strictly');
});

test('GitHub-dependent families run their strict paths', async () => {
    await step('labelled_issues').run(stepContext('acme/api'));
    await step('merge_conflicts').run(stepContext('acme/api'));
    assert.deepEqual(calls, ['fetchIssuesForRepo:acme/api:true', 'processDetectedIssue:true', 'sweepConflictedPullRequests:acme/api:true']);
});

test('the capability is created only with a known installation and can be opted out', () => {
    const store = new real.InMemoryResumeResyncStore();
    assert.equal(createRoutingResumeResync({ ...baseDeps, store, env: {} }), null);
    assert.equal(createRoutingResumeResync({ ...baseDeps, store, env: { GH_INSTALLATION_ID: '42', PROPR_ROUTING_RESUME_RESYNC: 'false' } }), null);
    const coordinator = createRoutingResumeResync({ ...baseDeps, store, env: { GH_INSTALLATION_ID: '42' } });
    assert.equal(coordinator?.capability, 'installation_resume_resync_v1');
    assert.equal(coordinator?.getStatus().installationId, 42);
    assert.equal(resolveResumeResyncInstallationId({ GH_INSTALLATION_ID: '4x2' }), null);
    assert.equal(resolveResumeResyncInstallationId({ GH_INSTALLATION_ID: ' 7 ' }), 7);
});

test('pull_request_comments discovers from the effective recovery start, not just this generation\'s gap', async () => {
    await step('pull_request_comments').run({ ...stepContext('acme/api'), gapStartedAt: '2026-10-11T00:00:00.000Z', recoveryStartedAt: '2026-10-10T00:00:00.000Z' });
    assert.deepEqual(calls, ['pollForPullRequestComments:acme/api:2026-10-10T00:00:00.000Z:true']);
});

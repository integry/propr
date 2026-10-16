import { after, test } from 'node:test';
import assert from 'node:assert';
import type { Redis } from 'ioredis';
import {
    closeConnection,
    InMemoryResumeResyncStore,
    RESYNC_INSTALLATION_FAMILIES,
    RESYNC_REPOSITORY_FAMILIES,
    ResyncRepositoryInaccessibleError,
} from '@propr/core';
import {
    createResumeResyncReconciler,
    createRoutingResumeResync,
    resolveResumeResyncInstallationId,
} from '../src/daemon/routingResumeResync.js';

after(async () => {
    await closeConnection();
});

const baseDeps = {
    redisClient: {} as Redis,
    PR_FOLLOWUP_TRIGGER_KEYWORDS: [],
    MODEL_LABEL_PATTERN: '^llm-(.+)$',
};

function stepContext(repository: string) {
    const [owner, repo] = repository.split('/');
    return {
        repository, owner, repo, gapStartedAt: '2026-10-10T00:00:00.000Z', gapEndedAt: '2026-10-12T00:00:00.000Z',
        correlationId: 'test', signal: new AbortController().signal,
    };
}

test('the daemon matrix implements every reconciliation family in order', () => {
    const reconciler = createResumeResyncReconciler({ ...baseDeps, listRepositories: () => ['acme/api'] });
    assert.deepEqual(reconciler.repositorySteps.map(step => step.family), [...RESYNC_REPOSITORY_FAMILIES]);
    assert.deepEqual(reconciler.installationSteps.map(step => step.family), [...RESYNC_INSTALLATION_FAMILIES]);
    assert.deepEqual(reconciler.listRepositories(), ['acme/api']);
});

test('repository access maps only 404 to inaccessible; a 403 (suspension or limit) retries', async () => {
    let status = 404;
    const getOctokit = async () => ({
        request: async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }); },
    }) as never;
    const access = createResumeResyncReconciler({ ...baseDeps, getOctokit }).repositorySteps[0];
    await assert.rejects(access.run(stepContext('acme/gone')), ResyncRepositoryInaccessibleError);
    status = 403;
    await assert.rejects(access.run(stepContext('acme/gone')), (error: Error) => !(error instanceof ResyncRepositoryInaccessibleError) && /HTTP 403/.test(error.message));
});

test('the capability is created only with a known installation and can be opted out', () => {
    const store = new InMemoryResumeResyncStore();
    assert.equal(createRoutingResumeResync({ ...baseDeps, store, env: {} }), null);
    assert.equal(createRoutingResumeResync({ ...baseDeps, store, env: { GH_INSTALLATION_ID: '42', PROPR_ROUTING_RESUME_RESYNC: 'false' } }), null);
    const coordinator = createRoutingResumeResync({ ...baseDeps, store, env: { GH_INSTALLATION_ID: '42' } });
    assert.equal(coordinator?.capability, 'installation_resume_resync_v1');
    assert.equal(coordinator?.getStatus().installationId, 42);
    assert.equal(resolveResumeResyncInstallationId({ GH_INSTALLATION_ID: '4x2' }), null);
    assert.equal(resolveResumeResyncInstallationId({ GH_INSTALLATION_ID: ' 7 ' }), 7);
});

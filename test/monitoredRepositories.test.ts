import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.PROPR_DEMO_MODE = 'true';

const {
    getCancelCiDuringFollowupWorkflowsForRepository,
    getReposFromEnv,
    isAutoCiFollowupEnabledForRepository,
    isMonitoredRepository,
    resolveMonitoredRepositories,
    seedMonitoredReposFromEnvironment,
} = await import('../packages/core/src/daemon/configLoader.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');

after(async () => {
    await closeConnection();
});

test('persisted setup repositories are used when no environment list is configured', async () => {
    let persistedLoads = 0;
    const repos = await resolveMonitoredRepositories({}, async () => {
        persistedLoads += 1;
        return ['owner/from-setup'];
    });

    assert.deepEqual(repos, ['owner/from-setup']);
    assert.equal(persistedLoads, 1);
});

test('an explicit environment list remains authoritative', async () => {
    let persistedLoads = 0;
    const environment = { GITHUB_REPOS_TO_MONITOR: 'owner/one, owner/two' };
    const repos = await resolveMonitoredRepositories(environment, async () => {
        persistedLoads += 1;
        return ['owner/from-setup'];
    });

    assert.deepEqual(getReposFromEnv(environment), ['owner/one', 'owner/two']);
    assert.deepEqual(repos, ['owner/one', 'owner/two']);
    assert.equal(persistedLoads, 0);
});

test('legacy CONFIG_REPO keeps persisted configuration authoritative', async () => {
    const repos = await resolveMonitoredRepositories({
        CONFIG_REPO: 'https://example.invalid/config.git',
        GITHUB_REPOS_TO_MONITOR: 'owner/environment',
    }, async () => ['owner/persisted']);

    assert.deepEqual(repos, ['owner/persisted']);
});

test('repository matching is case-insensitive and empty configuration fails closed', () => {
    assert.equal(isMonitoredRepository('Owner/Repo', ['owner/repo']), true);
    assert.equal(isMonitoredRepository('owner/other', ['owner/repo']), false);
    assert.equal(isMonitoredRepository('owner/repo', []), false);
});

test('automatic CI follow-up aggregates duplicate branch configurations independent of order', async () => {
    const disabledBranch = {
        id: 'repo-main',
        name: 'owner/repo',
        enabled: true,
        baseBranch: 'main',
        autoFollowupOnFailedCi: false,
    };
    const enabledBranch = {
        id: 'repo-release',
        name: 'OWNER/REPO',
        enabled: true,
        baseBranch: 'release',
        autoFollowupOnFailedCi: true,
    };

    assert.equal(await isAutoCiFollowupEnabledForRepository(
        'owner',
        'repo',
        async () => [disabledBranch, enabledBranch],
    ), true);
    assert.equal(await isAutoCiFollowupEnabledForRepository(
        'owner',
        'repo',
        async () => [enabledBranch, disabledBranch],
    ), true);
});

test('the selected follow-up CI cancellation workflows are read across the branch entries of a repository', async () => {
    const withoutSelection = { id: 'repo-main', name: 'owner/repo', enabled: true, baseBranch: 'main' };
    const withSelection = {
        id: 'repo-release',
        name: 'OWNER/REPO',
        enabled: true,
        baseBranch: 'release',
        cancelCiDuringFollowup: true,
        cancelCiDuringFollowupWorkflows: [' pr-build-check.yml ', 'PR-BUILD-CHECK.YML', 'Full Test Suite', ''],
    };
    const otherRepository = { id: 'other', name: 'owner/other', enabled: true, cancelCiDuringFollowupWorkflows: ['deploy.yml'] };

    assert.deepEqual(
        await getCancelCiDuringFollowupWorkflowsForRepository('owner', 'repo', async () => [withoutSelection, withSelection, otherRepository] as never),
        ['pr-build-check.yml', 'Full Test Suite'],
    );
    // A repository that selected nothing selects nothing, which cancels nothing.
    assert.deepEqual(
        await getCancelCiDuringFollowupWorkflowsForRepository('owner', 'repo', async () => [withoutSelection] as never),
        [],
    );
    // An unreadable configuration is not an empty selection: it must be reported
    // as unreadable so the caller skips cancellation instead of falling back.
    assert.equal(
        await getCancelCiDuringFollowupWorkflowsForRepository('owner', 'repo', async () => { throw new Error('database is down'); }),
        null,
    );
});

function seedStore(initial: { stored?: Array<{ id: string; name: string; enabled: boolean }> | null; seeded?: boolean } = {}) {
    const state = { stored: initial.stored ?? null, seeded: initial.seeded ?? false, saves: 0, reads: 0 };
    let id = 0;
    return {
        state,
        deps: {
            loadStored: async () => { state.reads += 1; return state.stored; },
            save: async (repos: Array<{ id: string; name: string; enabled: boolean }>) => { state.saves += 1; state.stored = repos; },
            loadSeeded: async () => state.seeded,
            markSeeded: async () => { state.seeded = true; },
            newId: () => `id-${++id}`,
        },
    };
}

test('a repository list that was never stored is seeded once from GITHUB_REPOS_TO_MONITOR', async () => {
    const { state, deps } = seedStore();
    const seeded = await seedMonitoredReposFromEnvironment({ GITHUB_REPOS_TO_MONITOR: 'owner/one, Owner/Two,owner/two' }, deps);
    assert.deepEqual(seeded, ['owner/one', 'owner/two']);
    assert.deepEqual(state.stored, [
        { id: 'id-1', name: 'owner/one', enabled: true },
        { id: 'id-2', name: 'owner/two', enabled: true },
    ]);
    assert.equal(state.seeded, true, 'the one-time marker is set');
    // A restart after the seed changes nothing.
    assert.deepEqual(await seedMonitoredReposFromEnvironment({ GITHUB_REPOS_TO_MONITOR: 'owner/one,owner/three' }, deps), []);
    assert.equal(state.saves, 1);
});

test('a list the user emptied on purpose is never re-seeded on restart', async () => {
    // The admin removed every repository: the key holds an empty list.
    const emptied = seedStore({ stored: [] });
    assert.deepEqual(await seedMonitoredReposFromEnvironment({ GITHUB_REPOS_TO_MONITOR: 'owner/one' }, emptied.deps), []);
    assert.equal(emptied.state.saves, 0);
    // Seeded earlier, then emptied (or the key removed): the marker keeps it from coming back.
    const marked = seedStore({ stored: null, seeded: true });
    assert.deepEqual(await seedMonitoredReposFromEnvironment({ GITHUB_REPOS_TO_MONITOR: 'owner/one' }, marked.deps), []);
    assert.equal(marked.state.saves, 0);
});

test('a stored repository list is never changed by the environment seed', async () => {
    const { state, deps } = seedStore({ stored: [{ id: 'kept', name: 'owner/other', enabled: false }] });
    assert.deepEqual(await seedMonitoredReposFromEnvironment({ GITHUB_REPOS_TO_MONITOR: 'owner/one' }, deps), []);
    assert.equal(state.saves, 0);
});

test('the environment seed skips CONFIG_REPO, demo mode, an empty list and a failed read', async () => {
    const { state, deps } = seedStore();
    for (const environment of [
        { GITHUB_REPOS_TO_MONITOR: 'owner/one', CONFIG_REPO: 'owner/config' },
        { GITHUB_REPOS_TO_MONITOR: 'owner/one', PROPR_DEMO_MODE: 'true' },
        { GITHUB_REPOS_TO_MONITOR: ' , ' },
        {},
    ]) {
        assert.deepEqual(await seedMonitoredReposFromEnvironment(environment, deps), []);
    }
    assert.equal(state.reads, 0);
    await assert.rejects(seedMonitoredReposFromEnvironment({ GITHUB_REPOS_TO_MONITOR: 'owner/one' }, {
        ...deps, loadStored: async () => { throw new Error('database is locked'); },
    }), /database is locked/);
    assert.equal(state.saves, 0);
});

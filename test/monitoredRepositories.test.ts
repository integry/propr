import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.PROPR_DEMO_MODE = 'true';

const {
    getReposFromEnv,
    isMonitoredRepository,
    resolveMonitoredRepositories,
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

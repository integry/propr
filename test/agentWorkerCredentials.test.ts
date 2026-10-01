import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { SimpleGit } from 'simple-git';
await mock.module('../packages/core/src/auth/githubAuth.js', {
    namedExports: { getAuthenticatedOctokit: async () => ({}), getGitHubInstallationToken: async () => 'worker-token' },
});
const { setupAuthenticatedRemote, configureGitRemoteAuthentication } = await import('../packages/core/src/git/repoBranching.js');

test('worker tokens authenticate git through its process environment and never the stored remote', async () => {
    let environment: Record<string, string> = {};
    let remote: string[] = [];
    const git = {
        env: (value: Record<string, string>) => { environment = value; },
        remote: async (value: string[]) => { remote = value; },
        getConfig: async () => ({ value: 'https://github.com/owner/repo.git' }),
    } as unknown as SimpleGit;
    await setupAuthenticatedRemote(git, 'https://github.com/owner/repo.git', 'write-token');
    assert.deepEqual(remote, ['set-url', 'origin', 'https://github.com/owner/repo.git']);
    assert.equal(environment.GIT_CONFIG_KEY_1, 'http.https://github.com/.extraheader');
    assert.equal(environment.GIT_CONFIG_VALUE_1, `AUTHORIZATION: basic ${Buffer.from('x-access-token:write-token').toString('base64')}`);
    await configureGitRemoteAuthentication(git);
    assert.equal(environment.GIT_CONFIG_VALUE_1, `AUTHORIZATION: basic ${Buffer.from('x-access-token:worker-token').toString('base64')}`);
});

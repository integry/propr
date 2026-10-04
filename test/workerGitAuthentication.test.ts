import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import type { SimpleGit } from 'simple-git';

let environment: Record<string, string | undefined> | undefined;
let remoteUrl = 'https://github.com/owner/private.git';
const events: string[] = [];
const auth = mock.fn(async () => ({ token: 'refreshed-token' }));
const git = {
    getConfig: async (key: string) => { events.push(key); return { value: remoteUrl }; },
    env: (value: Record<string, string | undefined>) => { environment = value; events.push('authenticated'); },
    fetch: async () => { assert.ok(environment?.GIT_CONFIG_VALUE_1); events.push('fetch'); },
    push: mock.fn(async (args: string[]) => { assert.ok(environment?.GIT_CONFIG_VALUE_1); events.push(`push:${args[0]}`); }),
    revparse: async () => 'main',
    raw: async (args: string[]) => { if (args[0] === 'fetch') { assert.ok(environment?.GIT_CONFIG_VALUE_1); events.push('fetch'); } return 'base-sha'; },
    status: async () => ({ conflicted: [] }),
};
await mock.module('simple-git', { namedExports: { simpleGit: () => git, SimpleGit: class {} } });
await mock.module('../packages/core/src/auth/githubAuth.js', {
    namedExports: { getGitHubInstallationToken: async () => { await Promise.resolve(); events.push('mint'); return 'worker-token'; }, getAuthenticatedOctokit: async () => ({ auth }) },
});
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, withCorrelation: () => logger };
await mock.module('../packages/core/src/utils/logger.js', { defaultExport: logger });
const { configureGitRemoteAuthentication, pushBranch } = await import('../packages/core/src/git/repoBranching.js');
const { mergeBaseIntoBranch } = await import('../packages/core/src/git/mergeOperations.js');

beforeEach(() => {
    environment = undefined; events.length = 0; remoteUrl = 'https://github.com/owner/private.git';
    auth.mock.resetCalls();
    git.push.mock.resetCalls();
});

for (const detail of [
    "could not read Username for 'https://github.com': No such device or address",
    "could not read Password for 'https://github.com': terminal prompts disabled",
    'Authentication failed',
]) {
    test(`push refreshes once after ${detail}`, async () => {
        git.push.mock.mockImplementationOnce(async () => { throw new Error(detail); });
        await pushBranch('/tmp/worktree', 'main', { authToken: 'expired-token' });
        assert.equal(git.push.mock.calls.length, 2);
        assert.equal(auth.mock.calls.length, 1);
        assert.deepEqual(auth.mock.calls[0].arguments, [{ type: 'installation', refresh: true }]);
        assert.equal(environment?.GIT_CONFIG_VALUE_1, `AUTHORIZATION: basic ${Buffer.from('x-access-token:refreshed-token').toString('base64')}`);
    });
}

test('unrelated push failures do not refresh credentials', async () => {
    git.push.mock.mockImplementationOnce(async () => { throw new Error('connection refused'); });
    await assert.rejects(pushBranch('/tmp/worktree', 'main', { authToken: 'worker-token' }), /connection refused/);
    assert.equal(auth.mock.calls.length, 0);
    assert.equal(git.push.mock.calls.length, 1);
});

test('a second authentication failure is returned without an unbounded retry', async () => {
    const fail = async () => { throw new Error("could not read Username for 'https://github.com': No such device or address"); };
    git.push.mock.mockImplementationOnce(fail, 0);
    git.push.mock.mockImplementationOnce(fail, 1);
    await assert.rejects(pushBranch('/tmp/worktree', 'main', { authToken: 'expired-token' }), /could not read Username/);
    assert.equal(auth.mock.calls.length, 1);
    assert.equal(git.push.mock.calls.length, 2);
});

test('push and merge authenticate the selected named remote or URL', async () => {
    await pushBranch('/tmp/worktree', 'main', { remote: 'fork' });
    assert.deepEqual(events, ['remote.fork.url', 'mint', 'authenticated', 'push:fork']);
    events.length = 0; environment = undefined;
    const result = await mergeBaseIntoBranch('/tmp/worktree', 'main', { baseRepoUrl: 'https://github.com/upstream/private.git' });
    assert.equal(result.outcome, 'clean');
    assert.deepEqual(events, ['mint', 'authenticated', 'fetch']);
});

test('legacy URL snapshots still get process credentials if cleanup strips the stored token', async () => {
    git.getConfig = async key => {
        events.push(key);
        const value = 'https://x-access-token:legacy-token@github.com/owner/private.git';
        // A concurrent launch scrubs the config after this read.
        remoteUrl = 'https://github.com/owner/private.git';
        return { value };
    };
    try {
        await configureGitRemoteAuthentication(git as unknown as SimpleGit);
        assert.equal(environment?.GIT_CONFIG_VALUE_1, `AUTHORIZATION: basic ${Buffer.from('x-access-token:worker-token').toString('base64')}`);
        assert.deepEqual(events, ['remote.origin.url', 'mint', 'authenticated']);
    } finally { git.getConfig = async key => { events.push(key); return { value: remoteUrl }; }; }
});

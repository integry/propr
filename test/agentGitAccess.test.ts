import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-agent-git-'));
const oldRoot = process.env.GIT_CLONES_BASE_PATH;
process.env.GIT_CLONES_BASE_PATH = root;
let repositories: Array<{ name: string; contextRepositories?: unknown }> = [];
let requests: Array<Record<string, unknown>> = [];
let permissions: Record<string, string> | undefined;
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: { loadMonitoredReposRaw: async () => repositories },
});
await mock.module('../packages/core/src/auth/githubAuth.js', {
    namedExports: { getAuthenticatedOctokit: async () => ({
        auth: async (options: Record<string, unknown>) => {
            requests.push(options);
            return { token: 'agent-scoped-token', permissions: permissions ?? options.permissions };
        },
        request: async (_route: string, params: { repo: string }) => ({ data: { id: params.repo === 'task' ? 1 : 2 } }),
    }) },
});
const { prepareAgentGitAccess, resolveContextRepositories, AGENT_READ_PERMISSIONS } = await import('../packages/core/src/agents/agentGitAccess.js');
const options = {
    prompt: 'Implement task', worktreePath: '/tmp/worktree', githubToken: 'worker-write-token',
    issueRef: { repoOwner: 'owner', repoName: 'task', number: 1 },
};
beforeEach(() => { repositories = []; requests = []; permissions = undefined; });
after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.GIT_CLONES_BASE_PATH;
    else process.env.GIT_CLONES_BASE_PATH = oldRoot;
});

test('implementation and direct goals replace the worker token with installation-wide read scope', async () => {
    for (const extra of [{}, { executionMode: 'goal' as const, environment: { PROPR_GOAL_LAUNCH_STRATEGY: 'direct' } }]) {
        const result = await prepareAgentGitAccess({ ...options, ...extra });
        assert.equal(result.githubToken, 'agent-scoped-token');
        assert.deepEqual(requests.at(-1), { type: 'installation', permissions: AGENT_READ_PERMISSIONS });
        assert.ok(result.gitMountArgs!.includes('/tmp/git-processor:/tmp/git-processor:ro'));
        assert.ok(result.gitMountArgs!.includes('/tmp/worktree/.git:/home/node/workspace/.git:ro'));
    }
});

test('only explicit orchestrated goals retain full permissions and writable git', async () => {
    const result = await prepareAgentGitAccess({ ...options, executionMode: 'goal', environment: { PROPR_GOAL_LAUNCH_STRATEGY: 'orchestrate' } });
    assert.deepEqual(requests[0], { type: 'installation' });
    assert.ok(result.gitMountArgs!.includes('/tmp/git-processor:/tmp/git-processor:rw'));
    const unknownStrategy = await prepareAgentGitAccess({ ...options, executionMode: 'goal' });
    assert.ok(unknownStrategy.gitMountArgs!.includes('/tmp/git-processor:/tmp/git-processor:ro'));
});

test('listed context uses repository IDs and exposes only allowed clones, preserving filesystem case', async () => {
    for (const name of ['task', 'Library', 'secret']) {
        await fs.mkdir(path.join(root, 'owner', name, '.git'), { recursive: true });
        await fs.writeFile(path.join(root, 'owner', name, '.git', 'config'), '[remote "origin"]\n url = https://x-access-token:old-write-token@github.com/owner/repo.git\n');
    }
    repositories = [{ name: 'owner/task', contextRepositories: ['owner/library'] }];
    const result = await prepareAgentGitAccess(options);
    assert.deepEqual(requests[0].repositoryIds, [2, 1]);
    assert.ok(result.gitMountArgs!.includes(`${root}/owner/Library:${root}/owner/Library:ro`));
    assert.ok(result.gitMountArgs!.includes(`${root}/owner/task:${root}/owner/task:ro`));
    assert.equal(result.gitMountArgs!.some(arg => arg.includes('secret') || arg.includes('/tmp/git-processor:')), false);
    assert.doesNotMatch(await fs.readFile(path.join(root, 'owner', 'Library', '.git', 'config'), 'utf8'), /old-write-token/);
});

test('none keeps task repository and branch policies intersect instead of broadening access', async () => {
    repositories = [{ name: 'owner/task', contextRepositories: ['owner/library'] }, { name: 'owner/task', contextRepositories: 'none' }];
    await prepareAgentGitAccess(options);
    assert.deepEqual(requests[0].repositoryIds, [1]);
    assert.deepEqual(resolveContextRepositories('owner/task', 'none'), ['owner/task']);
    assert.throws(() => resolveContextRepositories('owner/task', ['../secret']), /Invalid/);
    assert.throws(() => resolveContextRepositories('owner/task', 'typo'), /Context repositories/);
});

test('a broad or incomplete mint response fails closed', async () => {
    for (const bad of [{ contents: 'write' }, { contents: 'read' }, { ...AGENT_READ_PERMISSIONS, administration: 'read' }]) {
        permissions = bad;
        await assert.rejects(prepareAgentGitAccess(options), /refusing to launch/);
    }
});

test('restricted fork worktrees retain task git metadata without exposing the unlisted checkout', async () => {
    const common = path.join(root, 'contributor', 'fork', '.git');
    const workspace = path.join(root, 'test-workspace');
    await fs.mkdir(path.join(common, 'worktrees', 'task'), { recursive: true });
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, '.git'), `gitdir: ${common}/worktrees/task\n`);
    await fs.writeFile(path.join(common, 'config'), 'url = https://x-access-token:worker-secret@github.com/contributor/fork.git\n');
    repositories = [{ name: 'owner/task', contextRepositories: 'none' }];
    const result = await prepareAgentGitAccess({ ...options, worktreePath: workspace });
    assert.ok(result.gitMountArgs!.includes(`${common}:${common}:ro`));
    assert.equal(result.gitMountArgs!.includes(`${path.dirname(common)}:${path.dirname(common)}:ro`), false);
    assert.doesNotMatch(await fs.readFile(path.join(common, 'config'), 'utf8'), /worker-secret/);
    await fs.writeFile(path.join(workspace, '.git'), 'gitdir: /host-secret/.git/worktrees/task\n');
    await assert.rejects(prepareAgentGitAccess({ ...options, worktreePath: workspace }), /outside the managed clone/);
});

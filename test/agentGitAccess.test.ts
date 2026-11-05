import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-agent-git-'));
const legacyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-legacy-agent-git-'));
const defaultRoot = '/tmp/git-processor/clones';
// Redirect the production default root to an isolated fixture. Tests must never
// scrub a developer's or worker's actual retained clones.
const fixturePath = (file: string) => file === defaultRoot || file.startsWith(`${defaultRoot}/`)
    ? legacyRoot + file.slice(defaultRoot.length) : file;
const agentFs = {
    ...fs,
    readdir: (file: string, options: { withFileTypes: true }) => fs.readdir(fixturePath(file), options),
    readFile: (file: string, encoding: 'utf8') => fs.readFile(fixturePath(file), encoding),
    open: (file: string, flags: string, mode: number) => fs.open(fixturePath(file), flags, mode),
    rename: (from: string, to: string) => fs.rename(fixturePath(from), fixturePath(to)),
    rm: (file: string, options: { force: boolean }) => fs.rm(fixturePath(file), options),
};
await mock.module('node:fs/promises', { defaultExport: agentFs });
const oldRoot = process.env.GIT_CLONES_BASE_PATH;
process.env.GIT_CLONES_BASE_PATH = root;
let repositories: Array<{ name: string; contextRepositories?: unknown }> = [];
let requests: Array<Record<string, unknown>> = [];
let granted: Record<string, string> | undefined;
let rejectOptional = false;
let missingRepository: string | undefined;
let permissions: Record<string, string> | undefined;
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: { loadMonitoredReposStrict: async () => repositories },
});
await mock.module('../packages/core/src/auth/githubAuth.js', {
    namedExports: { getAuthenticatedOctokit: async () => ({
        auth: async (options: Record<string, unknown>) => {
            requests.push(options);
            if (rejectOptional && (options.permissions as Record<string, string>)?.checks) throw Object.assign(new Error('Permission not granted'), { status: 422 });
            return { token: 'agent-scoped-token', permissions: options.permissions ? permissions ?? options.permissions : granted };
        },
        request: async (_route: string, params: { repo: string }) => {
            if (params.repo === missingRepository) throw Object.assign(new Error('Not Found'), { status: 404 });
            return { data: { id: params.repo === 'task' ? 1 : 2 } };
        },
    }) },
});
const { prepareAgentGitAccess, prepareAnalysisGitAccess, resolveContextRepositories, resolveEffectiveContextRepositories, AGENT_READ_PERMISSIONS } = await import('../packages/core/src/agents/agentGitAccess.js');
const options = {
    prompt: 'Implement task', worktreePath: '/tmp/worktree', githubToken: 'worker-write-token',
    issueRef: { repoOwner: 'owner', repoName: 'task', number: 1 },
};
beforeEach(async () => {
    repositories = []; requests = []; permissions = undefined; granted = undefined; rejectOptional = false; missingRepository = undefined;
    for (const directory of [root, legacyRoot]) {
        await fs.rm(directory, { recursive: true, force: true });
        await fs.mkdir(directory);
    }
});
after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(legacyRoot, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.GIT_CLONES_BASE_PATH;
    else process.env.GIT_CLONES_BASE_PATH = oldRoot;
});

async function writeRetainedConfig(): Promise<string> {
    const configPath = path.join(legacyRoot, 'retained-owner', 'repo', '.git', 'config');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, 'url = https://x-access-token:retained-write-token@github.com/owner/repo.git\n');
    return configPath;
}

test('blanket mounts scrub configured and retained default-root clones before launch', async () => {
    const configPaths = [root, legacyRoot].map(base => path.join(base, 'retained-owner', 'repo', '.git', 'config'));
    for (const extra of [{}, { executionMode: 'goal' as const, environment: { PROPR_GOAL_LAUNCH_STRATEGY: 'direct' } },
        { executionMode: 'goal' as const, environment: { PROPR_GOAL_LAUNCH_STRATEGY: 'orchestrate' } }]) {
        for (const configPath of configPaths) {
            await fs.mkdir(path.dirname(configPath), { recursive: true });
            await fs.writeFile(configPath, '[remote "origin"]\n url = https://x-access-token:retained-write-token@github.com/owner/repo.git\n');
        }
        const result = await prepareAgentGitAccess({ ...options, ...extra });
        assert.ok(result.gitMountArgs!.some(arg => arg.startsWith('/tmp/git-processor:/tmp/git-processor:')));
        for (const configPath of configPaths) {
            assert.equal(await fs.readFile(configPath, 'utf8'), '[remote "origin"]\n url = https://github.com/owner/repo.git\n');
        }
    }
});

test('a missing configured root does not skip cleanup of retained default-root clones', async () => {
    const configPath = await writeRetainedConfig();
    process.env.GIT_CLONES_BASE_PATH = path.join(root, 'missing');
    try {
        await prepareAgentGitAccess(options);
        assert.doesNotMatch(await fs.readFile(configPath, 'utf8'), /retained-write-token/);
    } finally { process.env.GIT_CLONES_BASE_PATH = root; }
});

test('restricted mounts leave unexposed legacy clones alone, but blanket mounts must finish cleanup', async () => {
    const configPath = await writeRetainedConfig();
    await fs.writeFile(`${configPath}.lock`, 'concurrent worker operation');
    try {
        repositories = [{ name: 'owner/task', contextRepositories: 'none' }];
        const restricted = await prepareAgentGitAccess(options);
        assert.equal(restricted.gitMountArgs!.some(arg => arg.includes('/tmp/git-processor:') || arg.includes(defaultRoot)), false);
        assert.match(await fs.readFile(configPath, 'utf8'), /retained-write-token/);
        repositories = [];
        await assert.rejects(prepareAgentGitAccess(options), { code: 'EEXIST' });
        assert.equal(await fs.readFile(`${configPath}.lock`, 'utf8'), 'concurrent worker operation');
    } finally { await fs.rm(`${configPath}.lock`); }
    await prepareAgentGitAccess(options);
    assert.doesNotMatch(await fs.readFile(configPath, 'utf8'), /retained-write-token/);
});

test('legacy cleanup re-reads config after acquiring mutation authority', async t => {
    const configPath = await writeRetainedConfig();
    const open = agentFs.open;
    t.mock.method(agentFs, 'open', async (file: string, flags: string, mode: number) => {
        if (file === `${defaultRoot}/retained-owner/repo/.git/config.lock`) {
            await fs.appendFile(configPath, '# concurrent worker edit before lock\n');
        }
        return open(file, flags, mode);
    });
    await prepareAgentGitAccess(options);
    assert.equal(await fs.readFile(configPath, 'utf8'), 'url = https://github.com/owner/repo.git\n# concurrent worker edit before lock\n');
});

test('implementation and direct goals replace the worker token with installation-wide read scope', async () => {
    for (const extra of [{}, { executionMode: 'goal' as const, environment: { PROPR_GOAL_LAUNCH_STRATEGY: 'direct' } }]) {
        const result = await prepareAgentGitAccess({ ...options, ...extra });
        assert.equal(result.githubToken, 'agent-scoped-token');
        assert.deepEqual(requests.at(-1), { type: 'installation', refresh: true, permissions: AGENT_READ_PERMISSIONS });
        assert.ok(result.gitMountArgs!.includes('/tmp/git-processor:/tmp/git-processor:ro'));
        assert.ok(result.gitMountArgs!.includes('/tmp/worktree/.git:/home/node/workspace/.git:ro'));
    }
});

test('launches without repository access mint no token and mount no clones, even without a context policy', async () => {
    await fs.mkdir(path.join(root, 'owner', 'task', '.git'), { recursive: true });
    await fs.mkdir(path.join(legacyRoot, 'retained-owner', 'repo', '.git'), { recursive: true });
    for (const extra of [{}, { executionMode: 'goal' as const, environment: { PROPR_GOAL_LAUNCH_STRATEGY: 'orchestrate' } }]) {
        const result = await prepareAgentGitAccess({ ...options, ...extra, repositoryAccess: 'none' });
        assert.equal(result.githubToken, '');
        assert.deepEqual(result.gitMountArgs, []);
    }
    assert.deepEqual(requests, []);
});

test('only explicit orchestrated goals retain full permissions and writable git', async () => {
    const result = await prepareAgentGitAccess({ ...options, executionMode: 'goal', environment: { PROPR_GOAL_LAUNCH_STRATEGY: 'orchestrate' } });
    assert.deepEqual(requests[0], { type: 'installation', refresh: true });
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
    assert.deepEqual(requests.at(-1)!.repositoryIds, [2, 1]);
    assert.ok(result.gitMountArgs!.includes(`${root}/owner/Library:${root}/owner/Library:ro`));
    assert.ok(result.gitMountArgs!.includes(`${root}/owner/task:${root}/owner/task:ro`));
    assert.equal(result.gitMountArgs!.some(arg => arg.includes('secret') || arg.includes('/tmp/git-processor:')), false);
    assert.doesNotMatch(await fs.readFile(path.join(root, 'owner', 'Library', '.git', 'config'), 'utf8'), /old-write-token/);
});

test('none keeps task repository and branch policies intersect instead of broadening access', async () => {
    repositories = [{ name: 'owner/task', contextRepositories: ['owner/library'] }, { name: 'owner/task', contextRepositories: 'none' }];
    await prepareAgentGitAccess(options);
    assert.deepEqual(requests.at(-1)!.repositoryIds, [1]);
    assert.deepEqual(resolveContextRepositories('owner/task', 'none'), ['owner/task']);
    assert.throws(() => resolveContextRepositories('owner/task', ['../secret']), /Invalid/);
    assert.throws(() => resolveContextRepositories('owner/task', 'typo'), /Context repositories/);
});

test('the effective context policy that report workspaces check matches the token scope', async () => {
    repositories = [{ name: 'Owner/Task', contextRepositories: ['owner/library', 'owner/api'] }, { name: 'owner/task', contextRepositories: ['Owner/API'] }, { name: 'owner/other' }];
    assert.deepEqual(await resolveEffectiveContextRepositories('owner/task'), ['owner/api', 'owner/task']);
    repositories = [{ name: 'owner/task', contextRepositories: 'none' }];
    assert.deepEqual(await resolveEffectiveContextRepositories('owner/task'), ['owner/task']);
    repositories = [{ name: 'owner/task', contextRepositories: 'all' }, { name: 'owner/task' }];
    assert.equal(await resolveEffectiveContextRepositories('owner/task'), undefined);
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


test('optional read permissions are requested only when granted, including write grants', async () => {
    for (const optional of [{}, { checks: 'read' }, { actions: 'write', statuses: 'read' }, { checks: 'none' }]) {
        granted = { ...AGENT_READ_PERMISSIONS, ...optional };
        const result = await prepareAgentGitAccess(options);
        assert.equal(result.githubToken, 'agent-scoped-token');
        const expected = Object.fromEntries(Object.entries(optional).filter(([, value]) => value === 'read' || value === 'write').map(([key]) => [key, 'read']));
        assert.deepEqual(requests.at(-1)!.permissions, { ...AGENT_READ_PERMISSIONS, ...expected });
    }
});

test('context aliases resolving to the same repository mint with unique IDs', async () => {
    repositories = [{ name: 'owner/task', contextRepositories: ['owner/library', 'owner/old-library'] }];
    await prepareAgentGitAccess(options);
    assert.deepEqual(requests.at(-1)!.repositoryIds, [2, 1]);
});

test('unresolvable context reports the failing name and remedy without minting or broadening', async () => {
    repositories = [{ name: 'owner/task', contextRepositories: ['owner/deleted'] }];
    missingRepository = 'deleted';
    await assert.rejects(prepareAgentGitAccess(options), /contextRepositories entry "owner\/deleted".*owner\/task.*Correct or remove.*installation/);
    assert.equal(requests.length, 0);
});

test('analysis uses the repository policy and read-only token without mounting an absent workspace .git', async () => {
    for (const contextRepositories of ['none', ['owner/library'], 'all']) {
        repositories = [{ name: 'owner/task', contextRepositories }];
        for (const name of ['task', 'library', 'secret']) await fs.mkdir(path.join(root, 'owner', name), { recursive: true });
        const result = await prepareAnalysisGitAccess({ repository: 'owner/task' }, options.worktreePath);
        assert.equal(result.githubToken, 'agent-scoped-token');
        assert.deepEqual(requests.at(-1)!.permissions, AGENT_READ_PERMISSIONS);
        assert.equal(result.gitMountArgs.some(arg => arg.includes('workspace/.git') || arg.endsWith(':rw')), false);
        if (contextRepositories !== 'all') {
            assert.equal(result.gitMountArgs.some(arg => arg.includes('secret') || arg.includes('/tmp/git-processor:')), false);
            assert.deepEqual(requests.at(-1)!.repositoryIds, contextRepositories === 'none' ? [1] : [2, 1]);
        } else assert.ok(result.gitMountArgs.includes('/tmp/git-processor:/tmp/git-processor:ro'));
    }
});

test('context-free analysis and repository inspection never mint or expose clones', async () => {
    for (const analysis of [undefined, {}, { repository: 'owner/task', readOnlyWorkspacePath: '/tmp/scout', allowReadOnlyCommands: true }]) {
        assert.deepEqual(await prepareAnalysisGitAccess(analysis, '/tmp/analysis'), { githubToken: '', gitMountArgs: [] });
    }
    assert.equal(requests.length, 0);
});


test('a grant removed after discovery retries required scope without widening repository access', async () => {
    granted = { ...AGENT_READ_PERMISSIONS, checks: 'write' };
    rejectOptional = true;
    repositories = [{ name: 'owner/task', contextRepositories: 'none' }];
    const result = await prepareAgentGitAccess(options);
    assert.equal(result.githubToken, 'agent-scoped-token');
    assert.deepEqual(requests.slice(1), [
        { type: 'installation', refresh: true, permissions: { ...AGENT_READ_PERMISSIONS, checks: 'read' }, repositoryIds: [1] },
        { type: 'installation', refresh: true, permissions: AGENT_READ_PERMISSIONS, repositoryIds: [1] },
    ]);
});

test('scoped mint failure identifies installation and context configuration instead of broadening', async () => {
    repositories = [{ name: 'owner/task', contextRepositories: ['owner/not-installed'] }];
    permissions = { contents: 'write' };
    await assert.rejects(prepareAgentGitAccess(options), /Cannot mint agent token.*owner\/not-installed.*included in the App installation/);
    assert.equal(requests.length, 2);
});

test('relay minting discovers grants and preserves scope through an optional-permission rejection', async t => {
    const { createRelayAuth } = await import('../packages/core/src/auth/relayAuth.js');
    const { mintAgentGitHubToken } = await import('../packages/core/src/agents/agentGitAccess.js');
    const bodies: Array<{ permissions?: Record<string, string>; repository_ids?: number[] }> = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        if (body.permissions?.actions) return new Response('', { status: 422 });
        return Response.json({
            token: body.permissions ? 'relay-read-token' : 'relay-worker-token',
            permissions: body.permissions ?? { ...AGENT_READ_PERMISSIONS, contents: 'write', actions: 'write' },
            repositories: body.repository_ids?.map((id: number) => ({ id })),
        });
    });
    const auth = createRelayAuth({ relayUrl: 'https://relay.example.test', relayToken: 'relay-secret' });
    const token = await mintAgentGitHubToken({ auth } as unknown as import('../packages/core/src/auth/githubAuth.js').PaginatedOctokitInstance, false, [1, 2]);
    assert.equal(token, 'relay-read-token');
    assert.deepEqual(bodies, [
        {},
        { permissions: { ...AGENT_READ_PERMISSIONS, actions: 'read' }, repository_ids: [1, 2] },
        { permissions: AGENT_READ_PERMISSIONS, repository_ids: [1, 2] },
    ]);
});


test('cleanup waits for a competing writer and preserves its published config', async t => {
    const configPath = await writeRetainedConfig();
    await fs.writeFile(`${configPath}.lock`, 'held by git');
    const open = agentFs.open;
    let attempts = 0;
    t.mock.method(agentFs, 'open', async (file: string, flags: string, mode: number) => {
        if (file.endsWith('/config.lock')) {
            attempts++;
            if (attempts === 3) {
                await fs.writeFile(`${configPath}.lock`, 'url = https://x-access-token:new-secret@github.com/owner/repo.git\n# writer update\n');
                await fs.rename(`${configPath}.lock`, configPath);
            }
        }
        return open(file, flags, mode);
    });
    await prepareAgentGitAccess(options);
    assert.equal(attempts, 3);
    assert.equal(await fs.readFile(configPath, 'utf8'), 'url = https://github.com/owner/repo.git\n# writer update\n');
    await assert.rejects(fs.access(`${configPath}.lock`), { code: 'ENOENT' });
});

test('cleanup propagates non-contention errors without retrying or deleting another lock', async t => {
    await writeRetainedConfig();
    const open = t.mock.method(agentFs, 'open', async () => { throw Object.assign(new Error('Denied'), { code: 'EACCES' }); });
    await assert.rejects(prepareAgentGitAccess(options), { code: 'EACCES' });
    assert.equal(open.mock.callCount(), 1);
});

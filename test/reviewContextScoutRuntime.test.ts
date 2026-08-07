import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.js';
import { closeConnection } from '../packages/core/src/db/connection.js';
import type { AgentConfig } from '../packages/core/src/agents/types.js';

after(async () => closeConnection());

const ensureGitRepositoryMock = mock.fn();
let loadedSettings: Record<string, unknown> = {};
const loadSettingsMock = mock.fn(async () => loadedSettings);
const resolveLlmLabelMock = mock.fn(async (label: string) => {
    const [agentAlias, model] = label.split(':');
    return { agentAlias, model: model || label };
});
await mock.module('@propr/core', {
    namedExports: {
        createWorktreeFromExistingBranch: mock.fn(),
        ensureGitRepository: ensureGitRepositoryMock,
        ensureRepoCloned: mock.fn(),
        getRepoUrl: mock.fn(),
        loadSettings: loadSettingsMock,
        resolveLlmLabel: resolveLlmLabelMock,
    },
});
const { gatherReviewContext, prepareRelatedReviewContext } = await import('../src/jobs/reviewContextScout.js');
const { loadReviewRuntimeSettings } = await import('../src/jobs/reviewRuntimeSettings.js');

async function runMcpServer(
    source: string,
    repositoryRoot: string,
    requests: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
    const child = spawn(process.execPath, ['-e', source], {
        env: { ...process.env, PROPR_SCOUT_REPOSITORY_ROOT: repositoryRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    });
    assert.equal(exitCode, 0, stderr);
    return stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

test('review settings preserve dedicated and fast scout candidates separately', async () => {
    loadedSettings = {
        pr_review_context_model: '',
        analysis_model_fast: 'fast:analysis-model',
    };
    const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };

    const settings = await loadReviewRuntimeSettings(logger as never);

    assert.equal(settings.reviewContextModel, '');
    assert.equal(settings.fastAnalysisModel, 'fast:analysis-model');
});

test('review settings use the environment fast model when no persisted value exists', async () => {
    const previousFastModel = process.env.ANALYSIS_MODEL_FAST;
    loadedSettings = {};
    process.env.ANALYSIS_MODEL_FAST = 'env-fast:analysis-model';
    const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };

    try {
        const settings = await loadReviewRuntimeSettings(logger as never);

        assert.equal(settings.fastAnalysisModel, 'env-fast:analysis-model');
    } finally {
        if (previousFastModel === undefined) delete process.env.ANALYSIS_MODEL_FAST;
        else process.env.ANALYSIS_MODEL_FAST = previousFastModel;
    }
});

test('context scout runs Claude with repository-confined inspection options', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-review-scout-runtime-'));
    let receivedOptions: Record<string, unknown> | undefined;
    const analyze = mock.fn(async (_prompt: string, options: Record<string, unknown>) => {
        receivedOptions = options;
        return {
            success: true,
            response: '{"references":[]}',
            modelUsed: 'claude-model',
            executionTimeMs: 1,
        };
    });
    const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };

    const result = await gatherReviewContext({
        agent: { config: { type: 'claude', alias: 'claude-scout' }, analyze } as never,
        model: 'claude-model',
        worktreePath: root,
        prDiff: '## src/changed.ts\n+changed',
        changedFiles: ['src/changed.ts'],
        originalTaskSpec: 'Keep review scope focused',
        pullRequestNumber: 1762,
        repoOwner: 'integry',
        repoName: 'propr',
        taskId: 'task-1',
        correlationId: 'correlation-1',
        correlatedLogger: logger as never,
    });

    assert.equal(result.context, '');
    assert.equal(analyze.mock.callCount(), 1);
    assert.equal(receivedOptions?.timeoutMs, 30 * 60 * 1000);
    assert.equal(receivedOptions?.readOnlyWorkspacePath, root);
    assert.equal(receivedOptions?.allowReadOnlyCommands, true);
    assert.equal(receivedOptions?.responseFormat, 'json');
});

test('context scout rejects runtimes without repository-confined tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-review-scout-runtime-'));
    const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };

    for (const type of ['codex', 'opencode', 'antigravity', 'vibe'] as const) {
        const analyze = mock.fn();
        await assert.rejects(gatherReviewContext({
            agent: { config: { type, alias: `${type}-scout` }, analyze } as never,
            model: `${type}-model`,
            worktreePath: root,
            prDiff: '## src/changed.ts\n+changed',
            changedFiles: ['src/changed.ts'],
            originalTaskSpec: 'Keep review scope focused',
            pullRequestNumber: 1762,
            repoOwner: 'integry',
            repoName: 'propr',
            taskId: 'task-1',
            correlationId: 'correlation-1',
            correlatedLogger: logger as never,
        }), new RegExp(`unavailable for agent type: ${type}`));
        assert.equal(analyze.mock.callCount(), 0);
    }
});

test('context scout considers dedicated, fast, and reviewer candidates before deterministic fallback', async () => {
    const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };
    const initialEnsureGitCalls = ensureGitRepositoryMock.mock.callCount();
    const initialResolveCalls = resolveLlmLabelMock.mock.callCount();
    const agents = new Map([
        ['dedicated', { config: { type: 'codex', alias: 'dedicated' }, analyze: mock.fn() }],
        ['fast', { config: { type: 'opencode', alias: 'fast' }, analyze: mock.fn() }],
        ['reviewer', { config: { type: 'vibe', alias: 'reviewer' }, analyze: mock.fn() }],
    ]);
    const getAgentByAlias = mock.fn((alias: string) => agents.get(alias));
    const result = await prepareRelatedReviewContext({
        registry: { getAgentByAlias } as never,
        fallbackAssignment: { agentAlias: 'reviewer', model: 'reviewer-model' },
        configuredModel: 'dedicated:context-model',
        fastAnalysisModel: 'fast:analysis-model',
        state: { localRepoPath: undefined, worktreeInfo: undefined },
        githubToken: 'github-secret',
        branchName: 'feature',
        prDiff: 'diff',
        changedFiles: ['src/changed.ts'],
        originalTaskSpec: 'objective',
        pullRequestNumber: 1762,
        repoOwner: 'integry',
        repoName: 'propr',
        taskId: 'task-unsupported',
        correlationId: 'correlation-unsupported',
        correlatedLogger: logger as never,
    });

    assert.equal(result, '');
    assert.deepEqual(
        resolveLlmLabelMock.mock.calls.slice(initialResolveCalls).map(call => call.arguments[0]),
        ['dedicated:context-model', 'fast:analysis-model'],
    );
    assert.deepEqual(getAgentByAlias.mock.calls.map(call => call.arguments[0]), ['dedicated', 'fast', 'reviewer']);
    for (const agent of agents.values()) assert.equal(agent.analyze.mock.callCount(), 0);
    assert.equal(ensureGitRepositoryMock.mock.callCount(), initialEnsureGitCalls);
});

test('Claude scout Docker args expose only the confined repository MCP tools', () => {
    const config: AgentConfig = {
        id: 'claude-scout',
        type: 'claude',
        alias: 'claude-scout',
        enabled: true,
        dockerImage: 'propr/agent:latest',
        configPath: '/tmp/claude-scout-config',
        supportedModels: ['claude-sonnet'],
        envVars: {
            GITHUB_TOKEN: 'config-secret',
            GH_ENTERPRISE_TOKEN: 'enterprise-secret',
            SAFE_CONFIG_VALUE: 'kept',
        },
    };
    const args = buildDockerArgs(config, 1000, {
        worktreePath: '/tmp/scout-worktree',
        githubToken: 'direct-secret',
        issueNumber: 0,
        tools: 'Read,Grep,Glob,Bash',
        environment: {
            GITHUB_APP_PRIVATE_KEY: 'private-key-secret',
            SAFE_RUNTIME_VALUE: 'kept',
        },
        readOnlyWorkspace: true,
        repositoryInspection: true,
    });

    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--disable-slash-commands'));
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    assert.equal(
        args[args.indexOf('--allowedTools') + 1],
        [
            'mcp__propr_repository__read_repository_file',
            'mcp__propr_repository__glob_repository_paths',
            'mcp__propr_repository__search_repository_text',
        ].join(','),
    );
    assert.ok(args.includes('/tmp/scout-worktree:/home/node/workspace:ro'));
    assert.ok(!args.some(arg => arg.startsWith('/tmp/git-processor:/tmp/git-processor:')));
    assert.ok(!args.some(arg => /^(?:GH|GITHUB)_.*(?:TOKEN|KEY|SECRET|PASSWORD|PAT|PRIVATE_KEY)=/.test(arg)));
    assert.ok(!args.some(arg => arg.includes('direct-secret')));
    assert.ok(!args.some(arg => arg.includes('config-secret')));
    assert.ok(!args.some(arg => arg.includes('enterprise-secret')));
    assert.ok(!args.some(arg => arg.includes('private-key-secret')));
    assert.ok(args.includes('SAFE_CONFIG_VALUE=kept'));
    assert.ok(args.includes('SAFE_RUNTIME_VALUE=kept'));

    const argsWithoutCallerTools = buildDockerArgs(config, 1000, {
        worktreePath: '/tmp/scout-worktree',
        githubToken: 'direct-secret',
        issueNumber: 0,
        readOnlyWorkspace: true,
    });
    assert.equal(argsWithoutCallerTools[argsWithoutCallerTools.indexOf('--tools') + 1], '');
    assert.equal(argsWithoutCallerTools.includes('--mcp-config'), false);
});

test('Claude scout MCP tools reject traversal and escaping symlinks', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'propr-review-scout-mcp-'));
    const repositoryRoot = join(tempRoot, 'repository');
    const outsideRoot = join(tempRoot, 'outside');
    await mkdir(join(repositoryRoot, 'src'), { recursive: true });
    await mkdir(outsideRoot);
    await writeFile(join(repositoryRoot, 'src', 'consumer.ts'), 'first line\nneedle call\n');
    await writeFile(join(outsideRoot, 'secret.txt'), 'outside secret\n');
    await symlink(outsideRoot, join(repositoryRoot, 'escape'));

    const config: AgentConfig = {
        id: 'claude-scout', type: 'claude', alias: 'claude-scout', enabled: true,
        dockerImage: 'propr/agent:latest', configPath: '/tmp/claude-scout-config', supportedModels: [],
    };
    const args = buildDockerArgs(config, 1000, {
        worktreePath: repositoryRoot,
        githubToken: '',
        issueNumber: 0,
        readOnlyWorkspace: true,
        repositoryInspection: true,
    });
    const mcpConfig = JSON.parse(args[args.indexOf('--mcp-config') + 1]) as {
        mcpServers: { propr_repository: { args: string[] } };
    };
    const source = mcpConfig.mcpServers.propr_repository.args[1];
    const call = (id: number, name: string, toolArgs: Record<string, unknown>) => ({
        jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: toolArgs },
    });
    const responses = await runMcpServer(source, repositoryRoot, [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        call(3, 'read_repository_file', { path: 'src/consumer.ts', startLine: 2, endLine: 2 }),
        call(4, 'read_repository_file', { path: '../outside/secret.txt' }),
        call(5, 'read_repository_file', { path: 'escape/secret.txt' }),
        call(6, 'glob_repository_paths', { pattern: '*.ts' }),
        call(7, 'search_repository_text', { query: 'needle', glob: '*.ts' }),
    ]);
    const byId = new Map(responses.map(response => [response.id, response]));
    const resultFor = (id: number) => byId.get(id)?.result as {
        content?: Array<{ text: string }>;
        isError?: boolean;
        tools?: Array<{ name: string }>;
    };

    assert.deepEqual(resultFor(2).tools?.map(tool => tool.name), [
        'read_repository_file', 'glob_repository_paths', 'search_repository_text',
    ]);
    assert.match(resultFor(3).content?.[0].text || '', /needle call/);
    assert.equal(resultFor(4).isError, true);
    assert.match(resultFor(4).content?.[0].text || '', /outside the repository/);
    assert.equal(resultFor(5).isError, true);
    assert.match(resultFor(5).content?.[0].text || '', /resolves outside the repository/);
    assert.match(resultFor(6).content?.[0].text || '', /src\/consumer\.ts/);
    assert.match(resultFor(7).content?.[0].text || '', /needle call/);
});

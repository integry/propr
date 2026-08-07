import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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

test('context scout rejects every current runtime before model-controlled tools can run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-review-scout-runtime-'));
    const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };

    for (const type of ['claude', 'codex', 'opencode', 'antigravity', 'vibe'] as const) {
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
        ['reviewer', { config: { type: 'claude', alias: 'reviewer' }, analyze: mock.fn() }],
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

test('Claude read-only Docker args disable model-controlled tools and omit GitHub credentials', () => {
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
    });

    assert.equal(args[args.indexOf('--tools') + 1], '');
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
});

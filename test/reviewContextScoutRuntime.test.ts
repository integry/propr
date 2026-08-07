import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.js';
import { buildAnalysisSafetySuffix } from '../packages/core/src/agents/impl/utils/analysisPromptSafety.js';
import { closeConnection } from '../packages/core/src/db/connection.js';
import type { AgentConfig } from '../packages/core/src/agents/types.js';

after(async () => closeConnection());

const ensureGitRepositoryMock = mock.fn();
await mock.module('@propr/core', {
    namedExports: {
        createWorktreeFromExistingBranch: mock.fn(),
        ensureGitRepository: ensureGitRepositoryMock,
        ensureRepoCloned: mock.fn(),
        getRepoUrl: mock.fn(),
        resolveLlmLabel: mock.fn(),
    },
});
const { gatherReviewContext, prepareRelatedReviewContext } = await import('../src/jobs/reviewContextScout.js');

test('context scout uses a read-only workspace with a 30 minute timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-review-scout-runtime-'));
    let receivedOptions: Record<string, unknown> | undefined;
    const agent = {
        config: { type: 'claude', alias: 'claude-scout' },
        analyze: mock.fn(async (_prompt: string, options: Record<string, unknown>) => {
            receivedOptions = options;
            return {
                success: true,
                response: '{"references":[]}',
                modelUsed: 'fast-model',
                executionTimeMs: 1,
            };
        }),
    };
    const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };

    const result = await gatherReviewContext({
        agent: agent as never,
        model: 'fast-model',
        worktreePath: root,
        prDiff: '## src/changed.ts\n+changed',
        changedFiles: ['src/changed.ts'],
        originalTaskSpec: 'Keep review scope focused',
        pullRequestNumber: 1761,
        repoOwner: 'integry',
        repoName: 'propr',
        taskId: 'task-1',
        correlationId: 'correlation-1',
        correlatedLogger: logger as never,
    });

    assert.equal(result.context, '');
    assert.equal(receivedOptions?.timeoutMs, 30 * 60 * 1000);
    assert.equal(receivedOptions?.readOnlyWorkspacePath, root);
    assert.equal(receivedOptions?.allowReadOnlyCommands, true);
    assert.equal(receivedOptions?.responseFormat, 'json');
});

test('context scout skips agent runtimes without an enforceable file-tool allowlist', async () => {
    const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };
    const initialEnsureGitCalls = ensureGitRepositoryMock.mock.callCount();

    for (const type of ['codex', 'opencode', 'antigravity', 'vibe'] as const) {
        const analyze = mock.fn();
        const agent = { config: { type, alias: `${type}-scout` }, analyze };
        const result = await prepareRelatedReviewContext({
            registry: { getAgentByAlias: mock.fn(() => agent) } as never,
            fallbackAssignment: { agentAlias: `${type}-scout`, model: `${type}-model` },
            configuredModel: '',
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
        assert.equal(analyze.mock.callCount(), 0);
    }

    assert.equal(ensureGitRepositoryMock.mock.callCount(), initialEnsureGitCalls);
});

test('Claude scout Docker args enforce file tools and omit GitHub credentials', () => {
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

    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
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
    assert.equal(argsWithoutCallerTools[argsWithoutCallerTools.indexOf('--tools') + 1], 'Read,Grep,Glob');

    const safetySuffix = buildAnalysisSafetySuffix('json', true, '/tmp/scout-worktree');
    assert.match(safetySuffix, /file read, glob, and text search tools/);
    assert.match(safetySuffix, /Do not run shell commands/);
    assert.match(safetySuffix, /access the network/);
});

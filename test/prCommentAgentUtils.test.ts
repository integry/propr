import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.GH_APP_ID ||= '1';
process.env.GH_INSTALLATION_ID ||= '1';
const privateKeyPath = join(tmpdir(), 'propr-test-private-key.pem');
writeFileSync(privateKeyPath, '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n');
process.env.GH_PRIVATE_KEY_PATH ||= privateKeyPath;
process.env.DEFAULT_CLAUDE_MODEL ||= 'haiku';
const { generateSummaryTitle, resolveAndExecuteAgent } = await import('../src/jobs/prCommentAgentUtils.js');
const { AgentRegistry } = await import('@propr/core');
const { db } = await import('@propr/core');

after(async () => {
    await db.destroy();
});

const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
};

function baseOptions(overrides = {}) {
    return {
        combinedCommentBody: '',
        fallbackSubtitle: 'Fix requested without additional context.',
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'feature' },
        githubToken: { token: 'token' },
        pullRequestNumber: 123,
        prTitle: 'Add OAuth refresh handling',
        workflowLabel: 'Fix',
        repoOwner: 'integry',
        repoName: 'propr',
        correlationId: 'corr-1',
        taskId: 'task-1',
        correlatedLogger: logger,
        summarizationSettingsLoader: async () => ({ agent_alias: '' }),
        ...overrides,
    };
}

describe('generateSummaryTitle fallback behavior', () => {
    test('returns deterministic fallback for empty context without invoking the LLM', async () => {
        let analysisCalls = 0;
        const title = await generateSummaryTitle(baseOptions({
            titleContext: '',
            analysisRunner: async () => {
                analysisCalls += 1;
                return 'unused';
            },
        }));

        assert.strictEqual(title, 'Fix requested without additional context.');
        assert.strictEqual(analysisCalls, 0);
    });

    test('skips generated section headers when LLM summary generation fails', async () => {
        const title = await generateSummaryTitle(baseOptions({
            titleContext: [
                'Task: Fix PR #123: Add OAuth refresh handling',
                '',
                'Review feedback to address:',
                'Handle null refresh tokens in src/auth.ts before calling persistSession().',
            ].join('\n'),
            analysisRunner: async () => {
                throw new Error('LLM unavailable');
            },
        }));

        assert.strictEqual(title, 'Fix: Handle null refresh tokens in src/auth.ts before calling persistSession().');
    });

    test('records workflow-specific title generation metadata', async () => {
        let taskKind: unknown;
        let timeoutMs: unknown;
        let reasoningLevel: unknown;
        const title = await generateSummaryTitle(baseOptions({
            workflowLabel: 'Ultrafix',
            titleContext: 'Review feedback to address:\nKeep iterating on lint failures.',
            titleGenerationTimeoutMs: 1234,
            reasoningLevel: 'xhigh',
            analysisRunner: async options => {
                taskKind = options.metadata?.taskKind;
                timeoutMs = options.timeoutMs;
                reasoningLevel = options.reasoningLevel;
                return 'Resolve lint failures';
            },
        }));

        assert.strictEqual(title, 'Resolve lint failures');
        assert.strictEqual(taskKind, 'pr-ultrafix-title-generation');
        assert.strictEqual(timeoutMs, 1234);
        assert.strictEqual(reasoningLevel, 'xhigh');
    });

    test('removes surrounding quotes from generated subtitles', async () => {
        const title = await generateSummaryTitle(baseOptions({
            titleContext: 'Review feedback to address:\nHandle refresh token expiry.',
            analysisRunner: async () => '"Handle refresh token expiry"',
        }));

        assert.strictEqual(title, 'Handle refresh token expiry');
    });

    test('falls back to previous comment context when generated subtitle repeats implementation-summary text', async () => {
        const title = await generateSummaryTitle(baseOptions({
            workflowLabel: 'Ultrafix',
            prTitle: 'AI Implementation Summary',
            fallbackSubtitle: 'Ultrafix cycle requested without additional context.',
            titleContext: [
                'Task: Ultrafix PR #1492: Untitled pull request',
                '',
                'Recent useful PR comments (newest first):',
                '- @integry (PR comment): The titles should describe the recent request instead of repeating the implementation summary.',
            ].join('\n'),
            analysisRunner: async () => 'Ultrafix: AI Implementation Summary',
        }));

        assert.strictEqual(title, 'Ultrafix: The titles should describe the recent request instead of repeating the impl...');
    });

    test('does not include generic PR titles in the title-generation prompt', async () => {
        let prompt = '';
        await generateSummaryTitle(baseOptions({
            workflowLabel: 'Ultrafix',
            prTitle: 'AI Implementation Summary',
            titleContext: 'Recent useful PR comments (newest first):\n- @integry (PR comment): Use previous comment context.',
            analysisRunner: async options => {
                prompt = options.prompt;
                return 'Use previous comment context';
            },
        }));

        assert.ok(prompt.includes('for PR #123.'));
        assert.ok(!prompt.includes('PR #123: AI Implementation Summary'));
    });

    test('falls back when title generation exceeds the timeout', async () => {
        const title = await generateSummaryTitle(baseOptions({
            titleContext: 'Review feedback to address:\nHandle refresh token expiry quickly.',
            titleGenerationTimeoutMs: 1,
            analysisRunner: async () => new Promise<string>(resolve => {
                setTimeout(() => resolve('Too late'), 25);
            }),
        }));

        assert.strictEqual(title, 'Fix: Handle refresh token expiry quickly.');
    });

    test('does not duplicate workflow wording in fallback subtitles', async () => {
        const title = await generateSummaryTitle(baseOptions({
            titleContext: 'Review feedback to address:\nFix broken auth refresh handling.',
            analysisRunner: async () => {
                throw new Error('LLM unavailable');
            },
        }));

        assert.strictEqual(title, 'Fix broken auth refresh handling.');
    });
});

describe('resolveAndExecuteAgent reasoning levels', () => {
    test('passes PR follow-up reasoning level to the selected agent', async (t) => {
        const registry = AgentRegistry.getInstance();
        let capturedIssueRef: unknown;
        let capturedReasoningLevel: unknown;
        const agent = {
            config: { alias: 'claude', type: 'claude', enabled: true, defaultModel: 'claude-sonnet-test' },
            executeTask: async (options: { issueRef: unknown; reasoningLevel?: string }) => {
                capturedIssueRef = options.issueRef;
                capturedReasoningLevel = options.reasoningLevel;
                return {
                    success: true,
                    modelUsed: 'claude-sonnet-test',
                    executionTimeMs: 12,
                    summary: 'done',
                    conversationLog: [],
                };
            },
        };

        t.mock.method(registry, 'ensureInitialized', async () => undefined);
        t.mock.method(registry, 'getDefaultAgent', () => agent);
        t.mock.method(registry, 'getAgentByAlias', () => agent);

        const stateManager = {
            updateTaskState: async () => undefined,
            updateHistoryMetadata: async () => undefined,
            getTaskState: async () => null,
        };

        const result = await resolveAndExecuteAgent({
            llm: null,
            worktreePath: '/tmp/worktree',
            branchName: 'feature',
            prompt: 'Fix the PR',
            pullRequestNumber: 1705,
            repoOwner: 'integry',
            repoName: 'propr',
            taskId: 'task-pr-followup',
            stateManager: stateManager as never,
            correlatedLogger: logger as never,
            githubToken: 'token',
            redisClient: { set: async () => undefined } as never,
            reasoningLevel: 'ultracode',
        });

        assert.strictEqual(result.claudeResult.success, true);
        assert.strictEqual(capturedReasoningLevel, 'ultracode');
        assert.deepStrictEqual(capturedIssueRef, {
            number: 1705,
            repoOwner: 'integry',
            repoName: 'propr',
            reasoningLevel: 'ultracode',
        });
    });
});

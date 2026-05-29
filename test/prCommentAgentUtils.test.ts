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
const { generateSummaryTitle } = await import('../src/jobs/prCommentAgentUtils.js');
const { db } = await import('@propr/core');

after(async () => {
    await db.destroy();
});

const logger = {
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
        const title = await generateSummaryTitle(baseOptions({
            workflowLabel: 'Ultrafix',
            titleContext: 'Review feedback to address:\nKeep iterating on lint failures.',
            analysisRunner: async options => {
                taskKind = options.metadata?.taskKind;
                return 'Resolve lint failures';
            },
        }));

        assert.strictEqual(title, 'Resolve lint failures');
        assert.strictEqual(taskKind, 'pr-ultrafix-title-generation');
    });

    test('removes surrounding quotes from generated subtitles', async () => {
        const title = await generateSummaryTitle(baseOptions({
            titleContext: 'Review feedback to address:\nHandle refresh token expiry.',
            analysisRunner: async () => '"Handle refresh token expiry"',
        }));

        assert.strictEqual(title, 'Handle refresh token expiry');
    });
});

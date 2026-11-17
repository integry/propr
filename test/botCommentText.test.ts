import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Issue #3673: the text of bot comments and PR bodies, checked on builder output
// with the examples observed on integry/propr as inputs.
const { buildReviewComment, buildReviewErrorComment } = await import('../src/jobs/reviewCommentFormatter.js');
const { buildReviewCompletionCommentBody, countReviewOutcomes } = await import('../src/jobs/reviewCompletionComment.js');
const { buildFollowupFailureBody } = await import('../src/jobs/prCommentFailureComment.js');
const { sanitizeErrorMessage } = await import('../src/jobs/errorSanitizer.js');
const { describeFailureCause } = await import('@propr/shared');
const { stripUpstreamPageTitles } = await import('../src/jobs/upstreamPageTitle.js');
const { releasedTriggerLabels } = await import('../src/jobs/issueJobCompletionLabels.js');
const { generateCompletionComment, generateCompletionCommentParts } = await import('../packages/core/src/utils/github/logFiles.js');
const { buildCiFailureFollowupComment } = await import('../packages/core/src/webhook/ciFailureFollowup.js');
const { getCommentRevisionIdentity } = await import('../packages/core/src/webhook/commentEventHandler.js');
const { closeConnection } = await import('@propr/core');

const ERROR_MARKER = /<!-- propr:ai-review model="[^"]+" error="true"[^>]* -->/;
const assignment = { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' };
const validReview = [
    '## Overall Evaluation', 'Ready to merge.',
    '## Actionable Findings', 'No actionable findings.',
    '## Suggestions and Follow-ups', 'No suggestions.',
    '## Score', 'Score: 9/10',
].join('\n');

// createLogFiles writes under ./logs/executions; keep that out of the checkout.
const originalCwd = process.cwd();
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-comment-text-'));
process.chdir(scratchDir);

after(async () => {
    process.chdir(originalCwd);
    fs.rmSync(scratchDir, { recursive: true, force: true });
    await closeConnection();
});

describe('failed or invalid review comments (PR #3573, PR #3454)', () => {
    test('"Review failed:" with an empty message says why and carries the error marker', () => {
        const comment = buildReviewErrorComment('Claude Sonnet', 'claude-sonnet', '');

        assert.ok(comment.includes('❌ **Review failed.** The reviewer stopped without reporting an error.'));
        assert.doesNotMatch(comment, /\*\*Review failed:\*\* *\n/);
        assert.match(comment, ERROR_MARKER);
        assert.ok(!comment.includes('**Next step:**'));
    });

    test('a provider error becomes one sentence without the upstream page title', () => {
        const comment = buildReviewErrorComment('Claude Sonnet', 'claude-sonnet', 'API Error: 403 Attention Required! | Cloudflare');

        assert.ok(comment.includes('❌ **Review failed.** API Error: HTTP 403.'));
        assert.ok(!comment.includes('Cloudflare'));
    });

    test('"Review output was invalid" names the reason, drops the /fix block and is an error review', () => {
        const unparsable = buildReviewComment(assignment, {
            response: 'I could not finish the review.', modelUsed: 'claude-sonnet', executionTimeMs: 1000, success: true,
        }, 'https://propr.example/tasks/t-1', { taskId: 't-1' });
        const empty = buildReviewComment(assignment, {
            response: '   ', modelUsed: 'claude-sonnet', executionTimeMs: 1000, success: true,
        });

        assert.ok(unparsable.includes('⚠️ **Review output was invalid and could not be displayed safely.** The reviewer\'s response did not contain the required review sections in the expected order.'));
        assert.ok(empty.includes('⚠️ **Review output was invalid and could not be displayed safely.** The reviewer returned an empty response.'));
        for (const comment of [unparsable, empty]) {
            assert.ok(!comment.includes('**Next step:**'));
            assert.ok(!comment.includes('/fix all'));
            assert.match(comment, ERROR_MARKER);
        }
        assert.ok(unparsable.includes('[View Task](https://propr.example/tasks/t-1)'));
    });

    test('the parent comment does not count an invalid review as posted', () => {
        const invalidBody = buildReviewComment(assignment, {
            response: 'I could not finish the review.', modelUsed: 'claude-sonnet', executionTimeMs: 1000, success: true,
        });
        const validBody = buildReviewComment(assignment, {
            response: validReview, modelUsed: 'claude-sonnet', executionTimeMs: 1000, success: true,
        });
        const results = [
            { assignment, analysisResult: { response: validReview, modelUsed: 'claude-sonnet', executionTimeMs: 1, success: true }, commentBody: validBody, commentUrl: 'https://github.com/o/r/pull/1#issuecomment-1' },
            { assignment: { ...assignment, model: 'gpt-5' }, analysisResult: { response: 'x', modelUsed: 'gpt-5', executionTimeMs: 1, success: true }, commentBody: invalidBody, commentUrl: 'https://github.com/o/r/pull/1#issuecomment-2' },
        ];

        assert.deepStrictEqual(countReviewOutcomes(results), { posted: 1, failed: 1 });
        const body = buildReviewCompletionCommentBody(results, { authorsText: '@octo', taskUrl: 'https://propr.example/tasks/t-1' });
        assert.ok(body.startsWith('⚠️ **AI Code Review Complete** requested by @octo'));
        assert.ok(body.includes('Posted 1 review, 1 failed:'));
        assert.ok(!body.includes('Posted 2 reviews'));
        assert.match(body, /issuecomment-2\) \(failed\)/);
    });

    test('every review failing reads "Posted 0 reviews"', () => {
        const results = [{ assignment, analysisResult: { response: '', modelUsed: 'claude-sonnet', executionTimeMs: 0, success: false, error: '' } }];
        const body = buildReviewCompletionCommentBody(results, { authorsText: '@octo', taskUrl: 'https://propr.example/tasks/t-1' });
        assert.ok(body.includes('Posted 0 reviews, 1 failed:'));
    });
});

describe('failure comments (#3523, #3529, #3479)', () => {
    const authMessage = sanitizeErrorMessage('Agent execution failed: Failed to authenticate. API Error: 403 Attention Required! | Cloudflare');

    test('a follow-up failure gives the cause, keeps the status code, links the task and drops "Comment ID: 0"', () => {
        const { body } = buildFollowupFailureBody({
            repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 3611,
            authorsText: '@propr-ultrafix',
            error: new Error(authMessage),
            pushFailure: undefined,
            comments: [{ id: 0, author: 'propr-ultrafix' }],
            taskId: 'pr-comments-batch-1',
        });

        assert.strictEqual(authMessage, 'Agent execution failed: Failed to authenticate. API Error: HTTP 403');
        assert.ok(body.includes('**Cause:** Provider authentication failed.'));
        assert.ok(!body.includes('Attention Required'));
        assert.ok(!body.includes('Cloudflare'));
        assert.ok(!body.includes('Comment ID'));
        assert.ok(!body.includes('0✓'));
        assert.ok(!body.includes('Please check the logs'));
        assert.match(body, /\[View task details\]\(https?:\/\/[^)]+\/tasks\/pr-comments-batch-1\)/);
        assert.ok(!body.includes('propr:work-evidence'));
    });

    test('real request ids keep their processed receipts', () => {
        const { body } = buildFollowupFailureBody({
            repoOwner: 'o', repoName: 'r', pullRequestNumber: 1,
            authorsText: '@octo', error: new Error('boom'), pushFailure: undefined, taskId: 't-1',
            comments: [{ id: 0, author: 'propr-ultrafix' }, { id: 6935101767, author: 'octo' }, { id: 6935101768, author: 'octo' }],
        });
        assert.ok(body.includes('Comment IDs: 6935101767✓, 6935101768✓\n<!-- propr:work-evidence phase=failed'));
        assert.ok(!body.includes('0✓,'));
    });

    test('a crashed agent process is named in plain words', () => {
        assert.strictEqual(
            describeFailureCause('Claude process exited with code 132 after reporting a successful result'),
            'The agent process stopped unexpectedly.',
        );
        assert.strictEqual(describeFailureCause('Failed to authenticate. API Error: 403'), 'Provider authentication failed.');
        assert.strictEqual(describeFailureCause('Merge conflict in src/index.ts'), 'Merge conflict in src/index.ts.');
    });

    test('upstream HTML page titles are reduced to the status code', () => {
        assert.strictEqual(stripUpstreamPageTitles('API Error: 403 Attention Required! | Cloudflare'), 'API Error: HTTP 403');
        assert.strictEqual(stripUpstreamPageTitles('API Error: 502 <!DOCTYPE html><html><head><title>502 Bad Gateway</title></head></html>'), 'API Error: HTTP 502');
        assert.strictEqual(sanitizeErrorMessage('<!DOCTYPE html><html><title>Access denied | Forbidden 403</title></html>'), 'GitHub API forbidden (403)');
    });

    test('a failure report omits the <synthetic> model, zero usage lines and container log paths', async () => {
        const comment = await generateCompletionComment({
            success: false,
            error: 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare',
            model: '<synthetic>',
            executionTime: 4000,
            rawOutput: 'agent stdout',
            conversationLog: [{ type: 'assistant', message: { content: [] } }],
        }, { number: 3529, repoOwner: 'integry', repoName: 'propr' }, {
            publishedAs: 'issue_comment', taskUrl: 'https://propr.example/tasks/issue-3529',
        });

        assert.ok(!comment.includes('<synthetic>'));
        assert.ok(!comment.includes('LLM Model'));
        assert.ok(!comment.includes('Tokens used'));
        assert.ok(!comment.includes('API cost: $0.00'));
        assert.ok(!comment.includes('/logs/executions'));
        assert.ok(!comment.includes('Log files stored at'));
        assert.ok(comment.includes('[View task details and logs](https://propr.example/tasks/issue-3529)'));
    });

    test('a run that used tokens still reports them and their cost', async () => {
        const comment = await generateCompletionComment({
            success: true, model: 'claude-opus-4-6', executionTime: 1000,
            tokenUsage: { input_tokens: 1000, output_tokens: 500 },
        }, { number: 1, repoOwner: 'o', repoName: 'r' });
        assert.ok(comment.includes('- Tokens used: 1.5K tokens'));
        assert.match(comment, /- API cost: \$\d+\.\d{2}/);
        assert.ok(comment.includes('- LLM Model:'));
    });
});

describe('PR bodies (66 of 77 bodies carried a debug block)', () => {
    test('the logs part is one task link instead of Detailed Logs and Latest Conversation Messages', async () => {
        const parts = await generateCompletionCommentParts({
            success: true,
            executionTime: 60_000,
            model: 'claude-opus-4-6',
            summary: 'Implemented the change.',
            rawOutput: 'raw',
            conversationLog: Array.from({ length: 85 }, () => ({ type: 'assistant', message: { content: [{}] } })),
            tokenUsage: { input_tokens: 10, output_tokens: 5 },
        }, { number: 3582, repoOwner: 'integry', repoName: 'propr' }, { taskUrl: 'https://propr.example/tasks/issue-3582' });
        const body = [parts.run, parts.summary, parts.digest, parts.validation, parts.logs, parts.trailer].join('');

        assert.strictEqual(parts.logs, '[View task details and logs](https://propr.example/tasks/issue-3582)\n\n');
        assert.ok(!body.includes('Detailed Logs'));
        assert.ok(!body.includes('Conversation: 85 messages'));
        assert.ok(!body.includes('Session:'));
        assert.ok(!body.includes('Latest Conversation Messages'));
        assert.ok(!body.includes('ASSISTANT: [content unavailable]'));
        assert.ok(!body.includes('/logs/executions/issue-3582'));
        assert.strictEqual(body.match(/\/tasks\/issue-3582/g)?.length, 1);
    });

    test('without a task URL the logs part is empty', async () => {
        const parts = await generateCompletionCommentParts({ success: true, rawOutput: 'raw' }, { number: 1, repoOwner: 'o', repoName: 'r' });
        assert.strictEqual(parts.logs, '');
    });
});

describe('CI-failure comment links', () => {
    test('"Commit:" links the commit and a separate link points at the run', () => {
        const sha = '91f89c3b9e1d2c3b4a5f60718293a4b5c6d7e8f9';
        const runUrl = 'https://github.com/integry/propr/actions/runs/123/job/456';
        const body = buildCiFailureFollowupComment({
            owner: 'integry', repo: 'propr', prNumber: 3434,
            evidence: { kind: 'check_run', name: 'Run Full Test Suite', state: 'failure', sha, url: runUrl, source: 'check_run:456' },
        }, 'Test failed');

        assert.ok(body.includes(`- Commit: [\`91f89c3b9e1d\`](https://github.com/integry/propr/commit/${sha}) (\`${sha}\`)`));
        assert.ok(body.includes(`[View CI failure](${runUrl})`));
        assert.ok(!body.includes(`[\`91f89c3b9e1d\`](${runUrl})`));
    });
});

describe('labels and ids', () => {
    test('completion releases the AI trigger together with its processing label', () => {
        assert.deepStrictEqual(releasedTriggerLabels('AI', 'AI-processing'), ['AI', 'AI-processing']);
        assert.deepStrictEqual(releasedTriggerLabels(undefined, 'AI-processing'), ['AI', 'AI-processing']);
    });

    test('a comment without updated_at gives a revision id without "undefined"', () => {
        const identity = getCommentRevisionIdentity({ body: '/review' }, 'issue_comment');
        const jobId = `pr-comments-batch-integry-propr-3611-6935101767-${identity.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

        assert.match(identity, /^[a-f0-9]{12}$/);
        assert.ok(!jobId.includes('undefined'));
        assert.strictEqual(
            getCommentRevisionIdentity({ body: '/review', updated_at: '2026-11-17T10:00:00Z' }, 'issue_comment'),
            `2026-11-17T10:00:00Z:${identity}`,
        );
    });
});

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { excludeLabelsFor } from '../packages/core/src/daemon/issueDetection.js';
import { getCommentRevisionIdentity } from '../packages/core/src/webhook/commentEventHandler.js';
import { checkLabelConditions } from '../src/jobs/issueJob/github.js';
import { addMissingPullRequestLabels } from '../src/jobs/pullRequestLabels.js';
import { releasedTriggerLabels } from '../src/jobs/issueJobCompletionLabels.js';

after(async () => {
    await closeConnection();
});

describe('restarts of a rate-limited or finished issue (#3622 point 5)', () => {
    test('a waiting issue is not admitted again by its own label swap', () => {
        // ProPR adds AI-waiting and removes AI-processing; the labeled event is
        // admitted on the current labels, which must still exclude the issue.
        assert.ok(excludeLabelsFor(['AI']).includes('AI-waiting'));
        assert.deepEqual(excludeLabelsFor(['AI']), ['AI-processing', 'AI-done', 'AI-cancelled', 'AI-waiting']);
    });

    test('a delayed rate-limit retry does not start an issue that already has AI-done', () => {
        const context = { jobId: 'retry-1', AI_PRIMARY_TAG: 'AI', AI_DONE_TAG: 'AI-done' };
        const sibling = { number: 3556, isChildJob: true, dispatchId: 'dispatch-1', dispatchIssueLabels: ['AI'] };
        // The original dispatch run still continues past a sibling's done marker...
        assert.equal(checkLabelConditions(['AI-done'], { ...context, issueRef: sibling } as never, 'processing').skip, false);
        // ...but a rate-limit retry wakes after the issue is finished and is skipped.
        const retry = checkLabelConditions(['AI-done'], { ...context, issueRef: { ...sibling, isRetryFromRateLimit: true } } as never, 'processing');
        assert.equal(retry.skip, true);
        assert.equal(retry.terminalReason, 'skipped_issue_done');
    });
});

describe('labels and ids (#3622 point 6)', () => {
    test('PR labels are applied once even when the request is retried after it went through', async () => {
        const labels = new Set<string>();
        const posted: string[][] = [];
        let failNextPost = true;
        const octokit = {
            request: async <T>(route: string, params: Record<string, unknown>): Promise<T> => {
                if (route.startsWith('GET ')) return { data: [...labels].map(name => ({ name })) } as T;
                const requested = params.labels as string[];
                posted.push(requested);
                requested.forEach(label => labels.add(label));
                if (failNextPost) {
                    // Applied server-side, but the response was lost.
                    failNextPost = false;
                    throw Object.assign(new Error('socket hang up'), { status: 502 });
                }
                return { data: {} } as T;
            },
        };
        await addMissingPullRequestLabels(octokit, { owner: 'o', repo: 'r', pullRequestNumber: 3632 }, ['AI', 'llm-claude-opus55', 'AI'], 'label-test');
        assert.deepEqual(posted, [['AI', 'llm-claude-opus55']], 'the retry finds both labels present and posts nothing');

        // The existing-PR fallback after a successful create adds nothing either.
        await addMissingPullRequestLabels(octokit, { owner: 'o', repo: 'r', pullRequestNumber: 3632 }, ['AI', 'llm-claude-opus55'], 'label-existing');
        assert.equal(posted.length, 1);
    });

    test('completing an issue releases its trigger label along with the processing label', () => {
        assert.deepEqual(releasedTriggerLabels('AI', 'AI-processing'), ['AI', 'AI-processing']);
        assert.deepEqual(releasedTriggerLabels(undefined, 'AI-processing'), ['AI', 'AI-processing']);
    });

    test('a comment revision identity, and the task id built from it, never reads "undefined"', () => {
        const polled = { body: '/fix F1', updated_at: undefined as unknown as string };
        const identity = getCommentRevisionIdentity(polled, 'issue_comment');
        assert.doesNotMatch(identity, /undefined/);
        assert.match(identity, /^[a-f0-9]{12}$/);
        const edited = getCommentRevisionIdentity({ body: '/fix F1', updated_at: '2026-11-17T01:00:00Z' }, 'issue_comment');
        assert.equal(edited, `2026-11-17T01:00:00Z:${identity}`);
        const jobId = `pr-comments-batch-integry-propr-3611-6935101767-${identity.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        assert.doesNotMatch(jobId, /-undefined-/);
    });
});

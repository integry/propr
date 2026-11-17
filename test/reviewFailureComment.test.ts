import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const {
    buildReviewComment, buildReviewErrorComment, isReviewErrorComment, summarizeReviewFailure, UNKNOWN_REVIEW_FAILURE,
} = await import('../src/jobs/reviewCommentFormatter.js');
const { describeUnpublishableReview, parseStructuredReview } = await import('../src/jobs/reviewOutputParser.js');
const { buildReviewCommentWithReservedRecordRanges } = await import('../src/jobs/reviewFindingNumberAllocator.js');
const { closeConnection } = await import('@propr/core');

after(async () => {
    await closeConnection();
});

const assignment = { agentAlias: 'claude', model: 'claude-sonnet', label: 'Claude Sonnet' };
const TASK_URL = 'https://propr.example/tasks/review-task-1';

function invalidReview(response: string): string {
    return buildReviewComment(assignment, { response, modelUsed: 'claude-sonnet', executionTimeMs: 1000, success: true }, TASK_URL);
}

describe('failed and invalid review comments (#3622 point 1)', () => {
    test('an invalid review states its reason, carries the error marker and has no /fix block', () => {
        const comment = invalidReview('## Overall Evaluation\nLooks fine.\n\n## Score\nScore: 9/10');

        assert.match(comment, /Review output was invalid and could not be displayed safely\.\*\* The reviewer's response did not contain the required review sections/);
        assert.ok(isReviewErrorComment(comment));
        assert.match(comment, /<!-- propr:ai-review model="claude-sonnet" error="true" -->/);
        assert.doesNotMatch(comment, /Next step/);
        assert.doesNotMatch(comment, /\/fix/);
        assert.ok(comment.includes(`[View Task](${TASK_URL})`));
        assert.equal(parseStructuredReview(comment).status, 'invalid');
    });

    test('each contract failure gets its own one-sentence reason', () => {
        assert.equal(describeUnpublishableReview(''), 'The reviewer returned an empty response.');
        assert.match(describeUnpublishableReview('Looks good to me.'), /required review sections/);
        const noScore = [
            '## Overall Evaluation', 'Fine.', '## Actionable Findings', 'No actionable findings.',
            '## Suggestions and Follow-ups', 'No suggestions.', '## Score', 'Score: 11/10',
        ].join('\n');
        assert.match(describeUnpublishableReview(noScore), /exactly one score from 1 to 10/);
    });

    test('a failed review with an empty error still says why in one sentence', () => {
        for (const error of ['', '   ', undefined, null]) {
            const comment = buildReviewErrorComment('Claude Sonnet', 'claude-sonnet', error);
            assert.ok(comment.includes(`❌ **Review failed.** ${UNKNOWN_REVIEW_FAILURE}`));
            assert.ok(isReviewErrorComment(comment));
            assert.doesNotMatch(comment, /Review failed:\*\* *\n/);
        }
    });

    test('raw failure text is reduced to one sentence without paths or HTML', () => {
        const summary = summarizeReviewFailure('<html><title>Bad Gateway</title></html> upstream failed at /usr/src/app/logs/executions/x.json\nstack line 2');
        assert.doesNotMatch(summary, /<|usr\/src\/app|stack line/);
        assert.match(summary, /\.$/);
    });

    test('a failed analysis is not rendered or counted as a posted review', async () => {
        const { reviewCommentBody, findingCount } = await buildReviewCommentWithReservedRecordRanges(
            assignment,
            { response: '', modelUsed: 'claude-sonnet', executionTimeMs: 0, success: false, error: '' },
            TASK_URL,
            { redisClient: {} as never, issueRef: { repoOwner: 'o', repoName: 'r', pullRequestNumber: 1 }, observedNextFindingNumber: 1, observedNextSuggestionNumber: 1 },
        );
        assert.ok(isReviewErrorComment(reviewCommentBody));
        assert.ok(reviewCommentBody.includes(UNKNOWN_REVIEW_FAILURE));
        assert.equal(findingCount, 0);
    });

    test('a valid review is not an error comment', () => {
        const comment = invalidReview([
            '## Overall Evaluation', 'Ready.', '## Actionable Findings', 'No actionable findings.',
            '## Suggestions and Follow-ups', 'No suggestions.', '## Score', 'Score: 9/10',
        ].join('\n'));
        assert.equal(isReviewErrorComment(comment), false);
        assert.match(comment, /Next step/);
    });
});

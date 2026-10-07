import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import pino from 'pino';
import { up as createPullRequestState } from '../packages/core/src/db/migrations/20260829010000_add_notification_pull_request_state.js';
import { up as createReviewScores } from '../packages/core/src/db/migrations/20261006000000_create_review_scores.js';

const { buildReviewScoreInputs, persistReviewScores } = await import('../src/jobs/reviewScorePersistence.js');
const { buildReviewComment } = await import('../src/jobs/reviewCommentFormatter.js');
const { closeConnection, recordPullRequestOutcome, loadPullRequestScoreHistory } = await import('@propr/core');
const { loadReviewScoreSummary } = await import('../packages/api/routes/reviewScoreStats.js');

const logger = pino({ level: 'silent' });

function blocker(id: number): string[] {
    return [
        `### F${id}: Blocker ${id}`,
        `- **violatedRequirement:** Requirement ${id}.`,
        `- **evidence:** src/file.ts:${id} — demonstrated failure.`,
        '- **introducedByPR:** true — the PR added it.',
        '- **requiredForMerge:** true',
        `- **minimumCorrection:** Fix ${id}.`,
    ];
}

function reviewBody(score: number, blockers: number, suggestions: number): string {
    return [
        '## Overall Evaluation',
        'Evaluation.',
        '## Actionable Findings',
        ...(blockers ? Array.from({ length: blockers }, (_, index) => blocker(index + 1)).flat() : ['No actionable findings.']),
        '## Suggestions and Follow-ups',
        ...(suggestions ? Array.from({ length: suggestions }, (_, index) => [`### S${index + 1}: Suggestion ${index + 1}`, 'Optional.']).flat() : ['No suggestions.']),
        '## Score',
        `Score: ${score}/10`,
    ].join('\n');
}

const result = (response: string, success = true, extra: { commentId?: number; isPartial?: boolean } = { commentId: 1 }) => ({
    assignment: { agentAlias: 'codex', model: 'gpt-5.6', label: 'GPT', physicalAgentAlias: 'codex-pool-1', physicalModel: 'gpt-5.6' },
    analysisResult: { success, response, modelUsed: 'gpt-5.6-2026' },
    ...extra,
});

const CREATED_AT = new Date('2026-10-06T12:00:00.000Z');

describe('review score persistence', () => {
    let database: Knex;

    beforeEach(async () => {
        await database?.destroy();
        database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
        await database.schema.createTable('tasks', table => {
            table.string('task_id').primary();
            table.string('repository');
            table.integer('issue_number');
            table.integer('pr_number');
            table.string('task_type');
            table.string('model_name');
            table.text('initial_job_data');
            table.text('created_at');
        });
        await database.schema.createTable('llm_executions', table => {
            table.increments('execution_id');
            table.string('task_id');
            table.string('model_name');
            table.text('start_time');
            table.decimal('cost_usd', 10, 6);
        });
        await createPullRequestState(database);
        await createReviewScores(database);
        await database('tasks').insert([
            { task_id: 'issue-12', repository: 'acme/repo', issue_number: 12, pr_number: 40, task_type: 'issue', model_name: 'opus',
                initial_job_data: JSON.stringify({ agentAlias: 'claude' }), created_at: '2026-10-01T00:00:00.000Z' },
            // A later follow-up on the same PR is never the implementation task.
            { task_id: 'pr-comment-acme-40', repository: 'acme/repo', issue_number: 40, pr_number: 40, task_type: 'pr-comment',
                model_name: 'gpt-5.6', initial_job_data: '{}', created_at: '2026-10-02T00:00:00.000Z' },
        ]);
        await database('llm_executions').insert({ task_id: 'issue-12', model_name: 'claude-opus-5-5', start_time: '2026-10-01T00:01:00.000Z', cost_usd: 1.5 });
    });

    after(async () => {
        await database?.destroy();
        await closeConnection();
    });

    test('a review scoring 7/10 with 2 blockers and 3 suggestions writes the expected row', async () => {
        const written = await persistReviewScores([result(reviewBody(7, 2, 3))], {
            repository: 'acme/repo', pullRequestNumber: 40, taskId: 'pr-comment-acme-40-review', headSha: 'abc123',
        }, logger, database);
        assert.equal(written, 1);
        const [row] = await loadPullRequestScoreHistory(database, 'acme/repo', 40);
        const { id, created_at: createdAt, ...rest } = row;
        assert.ok(id);
        assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.deepEqual(rest, {
            repository_id: 'acme/repo',
            pr_number: 40,
            task_id: 'pr-comment-acme-40-review',
            implementation_task_id: 'issue-12',
            implementer_agent: 'claude',
            implementer_model: 'claude-opus-5-5',
            reviewer_agent: 'codex-pool-1',
            reviewer_model: 'gpt-5.6-2026',
            // A review that still lists blockers is capped at 6, as the
            // published comment and the Ultrafix goal check do.
            score: 6,
            blocker_count: 2,
            suggestion_count: 3,
            cycle_number: null,
            goal: null,
            goal_reached: null,
            source: 'review',
            head_sha: 'abc123',
        });
    });

    test('a clean review keeps its own score', () => {
        const [input] = buildReviewScoreInputs([result(reviewBody(7, 0, 3))], {
            repository: 'acme/repo', pullRequestNumber: 40, taskId: 'review-task', headSha: null,
        }, CREATED_AT);
        assert.equal(input.score, 7);
        assert.equal(input.blockerCount, 0);
        assert.equal(input.suggestionCount, 3);
    });

    test('a failing current-head check stores the capped score the comment publishes', async () => {
        const response = reviewBody(9, 0, 0);
        const context = { repository: 'acme/repo', pullRequestNumber: 40, taskId: 'review-task', headSha: 'abc123' };
        const comment = buildReviewComment(
            { label: 'GPT', model: 'gpt-5.6' } as never,
            { success: true, response, executionTimeMs: 0 } as never,
            undefined, { hasCurrentCheckFailure: true },
        );
        assert.match(comment, /^Score: 7\/10$/m);
        const [input] = buildReviewScoreInputs([result(response)], { ...context, hasCurrentCheckFailure: true }, CREATED_AT);
        assert.equal(input.score, 7);
        assert.equal(buildReviewScoreInputs([result(response)], context, CREATED_AT)[0].score, 9);
        assert.equal(await persistReviewScores([result(response)], { ...context, hasCurrentCheckFailure: true }, logger, database), 1);
        assert.equal((await loadPullRequestScoreHistory(database, 'acme/repo', 40))[0].score, 7);
    });

    test('a review the comment rejects for out-of-diff blocker evidence stores no score', () => {
        const response = reviewBody(5, 1, 0);
        const context = { repository: 'acme/repo', pullRequestNumber: 40, taskId: 'review-task', headSha: null };
        assert.equal(buildReviewScoreInputs([result(response)], { ...context, changedFilePaths: ['src/file.ts'] }, CREATED_AT).length, 1);
        assert.deepEqual(buildReviewScoreInputs([result(response)], { ...context, changedFilePaths: ['src/other.ts'] }, CREATED_AT), []);
    });

    test('an Ultrafix cycle records its cycle number, goal and source', async () => {
        await persistReviewScores([result(reviewBody(9, 0, 0))], {
            repository: 'acme/repo', pullRequestNumber: 40, taskId: 'ultrafix-review', headSha: 'def456',
            ultrafix: { ultrafixCycle: 3, ultrafixGoal: '8' },
        }, logger, database);
        const [row] = await loadPullRequestScoreHistory(database, 'acme/repo', 40);
        assert.equal(row.source, 'ultrafix');
        assert.equal(row.cycle_number, 3);
        assert.equal(row.goal, 8);
        assert.equal(row.score, 9);
        assert.equal(Boolean(row.goal_reached), true);
    });

    test('a clean high score does not reach the goal while a sibling reviewer in the same cycle blocks', async () => {
        const ultrafix = { ultrafixCycle: 2, ultrafixGoal: 8 };
        const context = { repository: 'acme/repo', pullRequestNumber: 40, taskId: 'ultrafix-review', headSha: null, ultrafix };
        // The clean 9 is even the newest review; the sibling's blocker still takes precedence.
        const inputs = buildReviewScoreInputs([
            result(reviewBody(5, 1, 0), true, { commentId: 10 }),
            result(reviewBody(9, 0, 0), true, { commentId: 11 }),
        ], context, CREATED_AT);
        assert.deepEqual(inputs.map(input => [input.score, input.blockerCount, input.goalReached]), [[5, 1, false], [9, 0, false]]);
        await persistReviewScores([
            result(reviewBody(5, 1, 0), true, { commentId: 10 }),
            result(reviewBody(9, 0, 0), true, { commentId: 11 }),
        ], context, logger, database);
        assert.deepEqual((await loadPullRequestScoreHistory(database, 'acme/repo', 40)).map(row => Boolean(row.goal_reached)), [false, false]);
    });

    test('an Ultrafix cycle reaches the goal only by the combined result of its whole review job', () => {
        const context = { repository: 'acme/repo', pullRequestNumber: 40, taskId: 'ultrafix-review', headSha: null,
            ultrafix: { ultrafixCycle: 2, ultrafixGoal: 8 } };
        const verdicts = (results: ReturnType<typeof result>[]) =>
            [...new Set(buildReviewScoreInputs(results, context, CREATED_AT).map(input => input.goalReached))];
        // Every reviewer clean, and the newest (highest comment ID) review meets the goal.
        assert.deepEqual(verdicts([result(reviewBody(9, 0, 0), true, { commentId: 12 }), result(reviewBody(8, 0, 0), true, { commentId: 13 })]), [true]);
        // The newest review's score is authoritative, not the best one.
        assert.deepEqual(verdicts([result(reviewBody(9, 0, 0), true, { commentId: 13 }), result(reviewBody(7, 0, 0), true, { commentId: 12 })]), [true]);
        assert.deepEqual(verdicts([result(reviewBody(9, 0, 0), true, { commentId: 12 }), result(reviewBody(7, 0, 0), true, { commentId: 13 })]), [false]);
        // A failed or unparseable sibling leaves the result set incomplete.
        assert.deepEqual(verdicts([result(reviewBody(9, 0, 0), true, { commentId: 12 }), result('', false, { commentId: 13 })]), [false]);
        assert.deepEqual(verdicts([result(reviewBody(9, 0, 0), true, { commentId: 12 }), result('No contract.', true, { commentId: 13 })]), [false]);
        // A review that was never posted, or covered only part of the diff, cannot pass the cycle.
        assert.deepEqual(verdicts([result(reviewBody(9, 0, 0), true, {})]), [false]);
        assert.deepEqual(verdicts([result(reviewBody(9, 0, 0), true, { commentId: 12, isPartial: true })]), [false]);
        // A plain review has no goal verdict.
        assert.equal(buildReviewScoreInputs([result(reviewBody(9, 0, 0))], { ...context, ultrafix: undefined }, CREATED_AT)[0].goalReached, null);
    });

    test('a job\'s scores are stored in publication order, so the newest posted review is the final score', async () => {
        const context = { repository: 'acme/repo', pullRequestNumber: 40, taskId: 'ultrafix-review', headSha: null,
            ultrafix: { ultrafixCycle: 2, ultrafixGoal: 8 } };
        // The newest review (comment 13) scored 9 but arrives first in the results.
        const results = [result(reviewBody(9, 0, 0), true, { commentId: 13 }), result(reviewBody(7, 0, 0), true, { commentId: 12 })];
        assert.deepEqual(buildReviewScoreInputs(results, context, CREATED_AT).map(input => [input.score, input.goalReached]),
            [[7, true], [9, true]]);
        // An unposted review never outranks a posted one.
        assert.deepEqual(buildReviewScoreInputs([
            result(reviewBody(5, 0, 0), true, { commentId: 20 }), result(reviewBody(6, 0, 0), true, {}),
        ], { ...context, ultrafix: undefined }, CREATED_AT).map(input => input.score), [6, 5]);

        await persistReviewScores(results, context, logger, database);
        assert.deepEqual((await loadPullRequestScoreHistory(database, 'acme/repo', 40)).map(row => row.score), [7, 9]);
        const finalScore = async () => (await loadReviewScoreSummary(database, null)).models[0].final_score.mean;
        // Open, then merged after both reviews.
        assert.equal(await finalScore(), 9);
        const [{ created_at: reviewedAt }] = await database('review_scores').select('created_at').limit(1);
        await recordPullRequestOutcome(database, { repository: 'acme/repo', prNumber: 40, action: 'closed', merged: true,
            mergedAt: new Date(Date.parse(reviewedAt) + 60_000).toISOString(), closedAt: new Date(Date.parse(reviewedAt) + 60_000).toISOString() });
        assert.equal(await finalScore(), 9);
    });

    test('failed and unparseable reviews write nothing', async () => {
        const written = await persistReviewScores([
            result(reviewBody(8, 0, 0), false),
            result('The reviewer forgot the contract.'),
        ], { repository: 'acme/repo', pullRequestNumber: 40, taskId: 'review-task', headSha: null }, logger, database);
        assert.equal(written, 0);
        assert.deepEqual(await loadPullRequestScoreHistory(database, 'acme/repo', 40), []);
    });

    test('a PR without a recorded implementation task keeps unknown implementer columns', async () => {
        await persistReviewScores([result(reviewBody(8, 0, 1))], {
            repository: 'acme/repo', pullRequestNumber: 99, taskId: 'review-task', headSha: null,
        }, logger, database);
        const [row] = await loadPullRequestScoreHistory(database, 'acme/repo', 99);
        assert.equal(row.implementation_task_id, null);
        assert.equal(row.implementer_model, null);
        assert.equal(row.implementer_agent, null);
    });

    test('a write failure is logged and never fails the review', async () => {
        await database.schema.dropTable('review_scores');
        const written = await persistReviewScores([result(reviewBody(8, 0, 0))], {
            repository: 'acme/repo', pullRequestNumber: 40, taskId: 'review-task', headSha: null,
        }, logger, database);
        assert.equal(written, 0);
    });

    test('PR outcomes are recorded on the PR state row and cleared on reopen', async () => {
        await recordPullRequestOutcome(database, { repository: 'acme/repo', prNumber: 40, action: 'closed', merged: false, closedAt: '2026-10-03T00:00:00Z' });
        assert.deepEqual(await database('notification_pull_request_state').select('outcome', 'closed_at', 'merged_at'),
            [{ outcome: 'closed', closed_at: '2026-10-03T00:00:00.000Z', merged_at: null }]);
        await recordPullRequestOutcome(database, { repository: 'acme/repo', prNumber: 40, action: 'reopened', merged: false });
        assert.deepEqual(await database('notification_pull_request_state').select('outcome', 'closed_at'), [{ outcome: null, closed_at: null }]);
        await recordPullRequestOutcome(database, { repository: 'acme/repo', prNumber: 40, action: 'closed', merged: true,
            mergedAt: '2026-10-04T00:00:00Z', closedAt: '2026-10-04T00:00:00Z' });
        assert.deepEqual(await database('notification_pull_request_state').select('outcome', 'closed_at', 'merged_at'),
            [{ outcome: 'merged', closed_at: '2026-10-04T00:00:00.000Z', merged_at: '2026-10-04T00:00:00.000Z' }]);
        // A merge is final: a stray reopen cannot clear it.
        await recordPullRequestOutcome(database, { repository: 'acme/repo', prNumber: 40, action: 'reopened', merged: false });
        assert.equal((await database('notification_pull_request_state').first('outcome'))?.outcome, 'merged');
    });
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createTaskListTestDatabase as createDatabase } from './fixtures/taskListDatabase.js';
import { getTasksFromDb } from '../routes/taskHelpers.js';
import { recordedReviewOutcome } from '../routes/runScore.js';

/**
 * The task projection the Tasks pane and Inbox read a review's follow-up
 * commands from. The UI's LatestRunCommands test reads this same file, so the
 * consumer is tested against what the API actually returns.
 */
const PROJECTION_FIXTURE = new URL('../../../propr-ui/src/components/TaskDetails/reviewOutcomeTasks.fixture.json', import.meta.url);
const PROJECTED_FIELDS = ['id', 'repository', 'prNumber', 'title', 'subtitle', 'status', 'commandMode', 'modelName', 'score', 'reviewOutcome', 'createdAt'] as const;

const astra = (success = true) => ({ model: 'gpt-6-astra', label: 'GPT-6 Astra', success });

/** One completed review per pull request, each recording a different outcome. */
const REVIEWS = [
  { id: 'review-clean', pr: 33, recap: 'Score 9/10 · 0 issues found', results: [astra()] },
  { id: 'review-findings', pr: 34, recap: 'Score 10/10 · 1 issue found: Guard the cursor', results: [astra()] },
  { id: 'review-failed', pr: 35, recap: 'Score 9/10 · 0 issues found · 1 reviewer failed', results: [astra(), { ...astra(false), model: 'claude' }] },
  // Written before reviews recorded per-reviewer results: the recap alone is not confirmation.
  { id: 'review-legacy', pr: 36, recap: 'Score 9/10 · 0 issues found', results: undefined },
  { id: 'review-unknown', pr: 37, recap: 'Score 10/10', results: [astra()] },
];

test('a completed review carries the outcome its completion recorded beside its score', async () => {
  const database = await createDatabase();
  await database('tasks').insert(REVIEWS.map((review, index) => ({
    task_id: review.id, repository: 'integry/propr', task_type: 'review', pr_number: review.pr, model_name: 'gpt-6-astra',
    created_at: `2026-10-18T0${index}:00:00.000Z`,
    initial_job_data: JSON.stringify({ title: `Review PR #${review.pr}`, subtitle: 'Review requested without additional context.', commandMode: 'review' }),
  })));
  await database('task_history').insert(REVIEWS.flatMap((review, index) => [
    { task_id: review.id, state: 'processing', timestamp: `2026-10-18T0${index}:01:00.000Z` },
    { task_id: review.id, state: 'completed', timestamp: `2026-10-18T0${index}:02:00.000Z`, metadata: JSON.stringify({
      commandMode: 'review', notificationRecap: review.recap, ...(review.results ? { reviewResults: review.results } : {}),
    }) },
  ]));

  const page = await getTasksFromDb({ db: database, status: 'all', repository: 'all', limit: 10, offset: 0 });
  const projected = (page.tasks as Array<Record<string, unknown>>)
    .map(task => Object.fromEntries(PROJECTED_FIELDS.map(field => [field, task[field]])))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const fixture = JSON.parse(await readFile(PROJECTION_FIXTURE, 'utf8')) as Array<Record<string, unknown>>;
  assert.deepEqual(projected, [...fixture].sort((a, b) => String(a.id).localeCompare(String(b.id))));
  assert.deepEqual(Object.fromEntries(projected.map(task => [task.id, task.reviewOutcome])), {
    'review-clean': 'clean', 'review-findings': 'findings', 'review-failed': 'reviewer_failed', 'review-legacy': null, 'review-unknown': null,
  });
});

test('a review outcome is clean only when the recap counts no issues and every recorded reviewer succeeded', () => {
  const recorded = (metadata: Record<string, unknown>) => recordedReviewOutcome(JSON.stringify(metadata));
  assert.equal(recorded({ notificationRecap: 'Score 9/10 · 0 issues found', reviewResults: [astra()] }), 'clean');
  assert.equal(recorded({ prResult: { notificationRecap: 'Scores 9/10, 8/10 · 0 issues found' }, reviewResults: [astra(), astra()] }), 'clean');
  assert.equal(recorded({ notificationRecap: 'Score 10/10 · 2 issues found', reviewResults: [astra()] }), 'findings');
  // A reviewer result that does not say it succeeded is a failed reviewer, even when the recap omits it.
  assert.equal(recorded({ notificationRecap: 'Score 9/10 · 0 issues found', reviewResults: [astra(), {}] }), 'reviewer_failed');
  assert.equal(recorded({ notificationRecap: '2 reviewers failed' }), 'reviewer_failed');
  assert.equal(recorded({ notificationRecap: 'Score 9/10 · 0 issues found', reviewResults: [] }), null);
  assert.equal(recorded({ notificationRecap: 'Score 9/10 · 0 issues found' }), null);
  assert.equal(recorded({ ultrafixScore: 10 }), null);
  assert.equal(recordedReviewOutcome('not json'), null);
});

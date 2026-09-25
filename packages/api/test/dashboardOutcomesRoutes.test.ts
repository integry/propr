import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Knex } from 'knex';
import {
  call,
  clearDashboardTestDatabase,
  createDashboardTestDatabase,
  createTestDashboardRoutes,
  daysAgo,
  minutesAgo,
  seedTask as seedTaskInto,
  type TaskSeed,
} from './dashboardTestHarness.js';

let database: Knex;

before(async () => { database = await createDashboardTestDatabase(); });
after(async () => database.destroy());
beforeEach(async () => clearDashboardTestDatabase(database));

const seedTask = (seed: TaskSeed): Promise<void> => seedTaskInto(database, seed);
const routes = () => createTestDashboardRoutes(database);

test('outcomes list completed runs only, one per task, newest first', async () => {
  await seedTask({
    taskId: 'shipped', issueNumber: 101, prNumber: 900, title: 'Ship the thing',
    states: [
      { state: 'pending', timestamp: minutesAgo(90) },
      { state: 'claude_execution', timestamp: minutesAgo(80) },
      // Heartbeat-style progress and indexing entries must never become outcomes.
      { state: 'indexing_update', timestamp: minutesAgo(70) },
      { state: 'post_processing', timestamp: minutesAgo(65) },
      { state: 'completed', timestamp: minutesAgo(62) },
      { state: 'completed', timestamp: minutesAgo(60) },
    ],
  });
  await seedTask({ taskId: 'shipped-later', issueNumber: 105, states: [{ state: 'completed', timestamp: minutesAgo(15) }] });
  // Failures belong to attention; cancellations and skipped jobs are bookkeeping.
  await seedTask({ taskId: 'broke', issueNumber: 102, states: [{ state: 'failed', timestamp: minutesAgo(30), reason: 'Lint failed' }] });
  await seedTask({ taskId: 'stopped', issueNumber: 103, states: [{ state: 'cancelled', timestamp: minutesAgo(20), reason: 'PR comment job rescheduled: pr_locked_by_other_job' }] });
  await seedTask({ taskId: 'skipped', issueNumber: 106, states: [{ state: 'completed', timestamp: minutesAgo(12), reason: 'PR comment job skipped: nothing to do' }] });
  await seedTask({ taskId: 'still-running', issueNumber: 104, states: [{ state: 'claude_execution', timestamp: minutesAgo(10) }] });
  await database('plan_issues').insert({
    draft_id: 'draft-2', repository: 'integry/propr', issue_number: 101, pr_number: 900,
    status: 'merged', task_id: 'shipped', created_at: daysAgo(2), updated_at: minutesAgo(10),
  });

  const outcomes = await call(routes().getOutcomes, { repository: 'all' });
  const items = outcomes.body.items as Array<Record<string, unknown>>;
  assert.deepEqual(items.map(item => item.taskId), ['shipped-later', 'shipped']);
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
  assert.equal(items[1].title, 'Ship the thing');
  assert.equal(items[1].taskType, 'issue');
  assert.equal(items[1].occurredAt, minutesAgo(60));

  const limited = await call(routes().getOutcomes, { repository: 'all', limit: '1' });
  assert.deepEqual((limited.body.items as Array<Record<string, unknown>>).map(item => item.taskId), ['shipped-later']);
});

test('outcomes carry the recorded recap as detail, never a bare "completed successfully"', async () => {
  await seedTask({ taskId: 'plain', issueNumber: 211, states: [{ state: 'completed', timestamp: minutesAgo(40), reason: 'Issue processing completed successfully' }] });
  await seedTask({ taskId: 'recapped', issueNumber: 212, states: [{ state: 'completed', timestamp: minutesAgo(30), reason: 'Issue processing completed successfully' }] });
  await seedTask({ taskId: 'generic', issueNumber: 213, taskType: 'pr-comment', states: [{ state: 'completed', timestamp: minutesAgo(20), reason: 'PR comment job completed' }] });
  await database('task_history').where({ task_id: 'recapped' })
    .update({ metadata: JSON.stringify({ prResult: { notificationRecap: 'Added retries across 3 files and opened a pull request.' } }) });
  await database('task_history').where({ task_id: 'generic' })
    .update({ metadata: JSON.stringify({ notificationRecap: 'Completed the pull request follow-up.' }) });

  const outcomes = await call(routes().getOutcomes, { repository: 'all' });
  const detail = new Map((outcomes.body.items as Array<Record<string, unknown>>).map(item => [item.taskId, item.detail]));
  assert.equal(detail.get('plain'), null);
  assert.equal(detail.get('recapped'), 'Added retries across 3 files and opened a pull request.');
  assert.equal(detail.get('generic'), null);
});

test('only reviews carry a score, taken from the review recap', async () => {
  await seedTask({ taskId: 'implementation', issueNumber: 201, states: [{ state: 'completed', timestamp: minutesAgo(30) }] });
  await seedTask({ taskId: 'review', issueNumber: 202, taskType: 'pr-comment', title: 'Review PR #202: Add retries', states: [{ state: 'completed', timestamp: minutesAgo(20) }] });
  await seedTask({ taskId: 'double-review', issueNumber: 203, taskType: 'pr-comment', title: 'Add caching', states: [{ state: 'completed', timestamp: minutesAgo(10) }] });
  // An implementation critique score is not a review result and is not shown.
  await database('llm_executions').insert({
    task_id: 'implementation',
    start_time: minutesAgo(35),
    cost_usd: 0.5,
    analysis_report: JSON.stringify({ report: JSON.stringify({ implementation_critique_score: 8 }) }),
  });
  await database('task_history').where({ task_id: 'review' })
    .update({ metadata: JSON.stringify({ commandMode: 'review', notificationRecap: 'Score 8/10 · 2 issues found: Missing test; Leaky timer' }) });
  await database('task_history').where({ task_id: 'double-review' })
    .update({ metadata: JSON.stringify({ commandMode: 'review', notificationRecap: 'Scores 9/10, 6/10 · 0 issues found' }) });

  const outcomes = await call(routes().getOutcomes, { repository: 'all' });
  const byTask = new Map((outcomes.body.items as Array<Record<string, unknown>>).map(item => [item.taskId, item]));
  assert.equal(byTask.get('implementation')?.score, null);
  assert.equal(byTask.get('review')?.score, 8);
  assert.equal(byTask.get('review')?.detail, '2 issues found: Missing test; Leaky timer');
  assert.equal(byTask.get('double-review')?.score, 6);
  assert.equal(byTask.get('double-review')?.detail, '0 issues found');
});

test('outcomes can be searched by title', async () => {
  await seedTask({ taskId: 'match', issueNumber: 221, title: 'Fix PR #221: Cache repository icons', states: [{ state: 'completed', timestamp: minutesAgo(30) }] });
  await seedTask({ taskId: 'miss', issueNumber: 222, title: 'Add retries', states: [{ state: 'completed', timestamp: minutesAgo(20) }] });
  // The word appears in the job data, but not in the title.
  await database('tasks').where({ task_id: 'miss' })
    .update({ initial_job_data: JSON.stringify({ title: 'Add retries', body: 'Also mention the icons cache' }) });

  const outcomes = await call(routes().getOutcomes, { repository: 'all', search: '  ICONS ' });
  assert.equal(outcomes.status, 200);
  assert.deepEqual((outcomes.body.items as Array<Record<string, unknown>>).map(item => item.taskId), ['match']);

  const tooLong = await call(routes().getOutcomes, { repository: 'all', search: 'x'.repeat(201) });
  assert.equal(tooLong.status, 400);
});

test('a recorded completion survives the follow-up run that starts after it', async () => {
  await seedTask({
    taskId: 'followed-up', issueNumber: 401,
    states: [
      { state: 'claude_execution', timestamp: minutesAgo(120) },
      { state: 'completed', timestamp: minutesAgo(100) },
      { state: 'pending', timestamp: minutesAgo(10) },
    ],
  });
  await seedTask({ taskId: 'clean-run', issueNumber: 402, states: [{ state: 'completed', timestamp: minutesAgo(90) }] });

  const outcomes = await call(routes().getOutcomes, { repository: 'all' });
  // The completion is an event that happened; the task moving on does not unhappen it.
  assert.deepEqual((outcomes.body.items as Array<Record<string, unknown>>).map(item => item.taskId), ['clean-run', 'followed-up']);
});

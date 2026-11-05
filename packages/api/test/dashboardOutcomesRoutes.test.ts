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

test('a title search matches the decoded title, including characters JSON escapes', async () => {
  await seedTask({ taskId: 'quoted', issueNumber: 231, title: 'Handle "retry budget" failures', states: [{ state: 'completed', timestamp: minutesAgo(30) }] });
  await seedTask({ taskId: 'pathed', issueNumber: 232, title: 'Move C:\\temp\\cache under /var/cache', states: [{ state: 'completed', timestamp: minutesAgo(25) }] });
  await seedTask({ taskId: 'unrelated', issueNumber: 233, title: 'Add retries', states: [{ state: 'completed', timestamp: minutesAgo(20) }] });

  const quoted = await call(routes().getOutcomes, { repository: 'all', search: '"retry budget"' });
  assert.deepEqual((quoted.body.items as Array<Record<string, unknown>>).map(item => item.taskId), ['quoted']);
  const pathed = await call(routes().getOutcomes, { repository: 'all', search: 'c:\\temp\\cache under /var' });
  assert.deepEqual((pathed.body.items as Array<Record<string, unknown>>).map(item => item.taskId), ['pathed']);
});

test('a title search reaches past newer runs that match only in their bodies', async () => {
  const bodyOnly = Array.from({ length: 1100 }, (_, index) => ({
    task_id: `body-${index}`, repository: 'integry/propr', issue_number: 1000 + index, task_type: 'issue',
    created_at: minutesAgo(10), initial_job_data: JSON.stringify({ title: `Run ${index}`, body: 'Touches the icons cache' }),
  }));
  for (let start = 0; start < bodyOnly.length; start += 100) {
    const batch = bodyOnly.slice(start, start + 100);
    await database('tasks').insert(batch);
    await database('task_history').insert(batch.map(row => ({ task_id: row.task_id, state: 'completed', timestamp: minutesAgo(10), metadata: '{}' })));
  }
  await seedTask({ taskId: 'older-match', issueNumber: 241, title: 'Cache repository icons', states: [{ state: 'completed', timestamp: daysAgo(3) }] });
  await seedTask({ taskId: 'quoted-match', issueNumber: 242, title: 'Rename "icons" folder', states: [{ state: 'completed', timestamp: daysAgo(4) }] });

  const outcomes = await call(routes().getOutcomes, { repository: 'all', search: 'icons' });
  assert.deepEqual((outcomes.body.items as Array<Record<string, unknown>>).map(item => item.taskId), ['older-match', 'quoted-match']);
  const quoted = await call(routes().getOutcomes, { repository: 'all', search: '"icons"' });
  assert.deepEqual((quoted.body.items as Array<Record<string, unknown>>).map(item => item.taskId), ['quoted-match']);
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

test('a follow-up that was skipped does not hide the completion before it', async () => {
  await seedTask({
    taskId: 'skipped-follow-up', issueNumber: 403, title: 'Add retries',
    states: [
      { state: 'claude_execution', timestamp: minutesAgo(120) },
      { state: 'completed', timestamp: minutesAgo(100) },
      // Followed up under the same id, and the follow-up found nothing to do.
      { state: 'pending', timestamp: minutesAgo(20) },
      { state: 'completed', timestamp: minutesAgo(15), reason: 'PR comment job skipped: nothing to do' },
    ],
  });
  await seedTask({ taskId: 'only-skipped', issueNumber: 404, title: 'Add retries', states: [
    { state: 'completed', timestamp: minutesAgo(5), reason: 'PR comment job skipped: nothing to do' },
  ] });
  await database('task_history').where({ task_id: 'skipped-follow-up', timestamp: minutesAgo(100) })
    .update({ metadata: JSON.stringify({ notificationRecap: 'Added retries across 3 files and opened a pull request.' }) });

  for (const query of [{ repository: 'all' }, { repository: 'all', search: 'retries' }]) {
    const items = (await call(routes().getOutcomes, query)).body.items as Array<Record<string, unknown>>;
    assert.deepEqual(
      items.map(item => [item.taskId, item.occurredAt, item.detail]),
      [['skipped-follow-up', minutesAgo(100), 'Added retries across 3 files and opened a pull request.']],
    );
  }
});

test('a completion shows its own run\'s recap and score, never an earlier run\'s', async () => {
  await seedTask({
    taskId: 'rereviewed', issueNumber: 411, taskType: 'pr-comment', title: 'Review PR #411: Add retries',
    states: [
      { state: 'claude_execution', timestamp: minutesAgo(200) },
      { state: 'completed', timestamp: minutesAgo(180) },
      // Followed up: the same task runs again and completes without a recap.
      { state: 'pending', timestamp: minutesAgo(60) },
      { state: 'claude_execution', timestamp: minutesAgo(50) },
      { state: 'completed', timestamp: minutesAgo(30) },
    ],
  });
  await seedTask({
    taskId: 'two-step', issueNumber: 412,
    states: [
      { state: 'claude_execution', timestamp: minutesAgo(100) },
      { state: 'completed', timestamp: minutesAgo(90) },
      { state: 'completed', timestamp: minutesAgo(80) },
      // A later run has started, but has not completed yet.
      { state: 'pending', timestamp: minutesAgo(10) },
    ],
  });
  await database('task_history').where({ task_id: 'rereviewed', timestamp: minutesAgo(180) })
    .update({ metadata: JSON.stringify({ commandMode: 'review', notificationRecap: 'Score 9/10 · 0 issues found' }) });
  // The recap sits on the first of the run's two completions.
  await database('task_history').where({ task_id: 'two-step', timestamp: minutesAgo(90) })
    .update({ metadata: JSON.stringify({ notificationRecap: 'Added retries across 3 files and opened a pull request.' }) });

  const outcomes = await call(routes().getOutcomes, { repository: 'all' });
  const byTask = new Map((outcomes.body.items as Array<Record<string, unknown>>).map(item => [item.taskId, item]));
  const rereviewed = byTask.get('rereviewed');
  assert.deepEqual([rereviewed?.occurredAt, rereviewed?.score, rereviewed?.detail], [minutesAgo(30), null, null]);
  const previousReview = (rereviewed?.earlierUpdates as Array<Record<string, unknown>>)[0];
  assert.deepEqual([previousReview.taskId, previousReview.occurredAt, previousReview.taskType, previousReview.score, previousReview.detail],
    ['rereviewed', minutesAgo(180), 'review', 9, '0 issues found']);
  assert.notEqual(previousReview.id, rereviewed?.id);
  assert.equal(rereviewed?.eventCount, 2);
  const twoStep = byTask.get('two-step');
  assert.deepEqual(
    [twoStep?.occurredAt, twoStep?.detail],
    [minutesAgo(80), 'Added retries across 3 files and opened a pull request.'],
  );
});

test('entity rollup precedes the limit and keeps the newest recap and complete event count', async () => {
  for (let index = 0; index < 12; index++) {
    await seedTask({ taskId: `fix-${index}`, issueNumber: 2583, prNumber: 2583, taskType: 'pr-comment', title: 'Keep plan revision history', states: [
      { state: 'completed', timestamp: minutesAgo(index + 1), metadata: { notificationRecap: `Revision ${index}` } },
    ] });
  }
  await seedTask({ taskId: 'other-pr', issueNumber: 2565, prNumber: 2565, states: [{ state: 'completed', timestamp: minutesAgo(40) }] });
  await seedTask({ taskId: 'skip', issueNumber: 2583, prNumber: 2583, states: [{ state: 'completed', timestamp: minutesAgo(0), reason: 'PR comment job skipped: no work' }] });
  // Repeated terminal bookkeeping still counts as one task outcome.
  await database('task_history').insert({ task_id: 'fix-0', state: 'completed', timestamp: minutesAgo(0.5), metadata: '{}' });
  const response = await call(routes().getOutcomes, { limit: '2' });
  const items = response.body.items as Array<Record<string, unknown>>;
  assert.deepEqual(items.map(item => [item.prNumber, item.eventCount]), [[2583, 12], [2565, 1]]);
  assert.equal(items[0].taskId, 'fix-0');
  assert.equal(items[0].detail, 'Revision 0');
  const searched = await call(routes().getOutcomes, { search: 'revision', limit: '1' });
  assert.equal((searched.body.items as Array<Record<string, unknown>>)[0].eventCount, 12);
});

test('rollup resolves PR identity from persisted, legacy, job and result records', async () => {
  const seeds = [
    { taskId: 'explicit', issueNumber: 10, prNumber: 900 },
    { taskId: 'pr-comment-legacy', issueNumber: 900 },
    { taskId: 'pr-comments-legacy', issueNumber: 900 },
    { taskId: 'job-pr', issueNumber: 10 },
    { taskId: 'result-pr', issueNumber: 10 },
  ];
  for (const [index, seed] of seeds.entries()) {
    await seedTask({ ...seed, title: 'Preserve revision history', states: [{ state: 'completed', timestamp: minutesAgo(index + 1) }] });
  }
  await database('tasks').where({ task_id: 'job-pr' }).update({ initial_job_data: JSON.stringify({ pullRequestNumber: 900 }) });
  await database('tasks').where({ task_id: 'result-pr' }).update({ final_result: JSON.stringify({ postProcessing: { pr: { number: 900 } } }) });
  // Repository and entity kind must prevent accidental collisions.
  await seedTask({ taskId: 'other-repo', repository: 'acme/app', prNumber: 900, states: [{ state: 'completed', timestamp: minutesAgo(20) }] });
  await seedTask({ taskId: 'issue-900', issueNumber: 900, states: [{ state: 'completed', timestamp: minutesAgo(30) }] });
  const items = (await call(routes().getOutcomes)).body.items as Array<Record<string, unknown>>;
  assert.deepEqual(items.map(item => item.eventCount), [5, 1, 1]);
  const scoped = (await call(routes().getOutcomes, { repository: 'acme/app' })).body.items as Array<Record<string, unknown>>;
  assert.deepEqual(scoped.map(item => item.taskId), ['other-repo']);
});

test('goal and issue fallback identities roll up while anonymous tasks remain distinct', async () => {
  for (const taskId of ['goal-a', 'goal-b', 'issue-a', 'issue-b', 'anonymous-a', 'anonymous-b']) {
    await seedTask({ taskId, issueNumber: taskId.startsWith('issue') ? 42 : null, states: [{ state: 'completed', timestamp: minutesAgo(1) }] });
  }
  await database('tasks').whereIn('task_id', ['goal-a', 'goal-b']).update({ initial_job_data: JSON.stringify({ goalId: 'goal-1', title: 'A goal' }) });
  await database('tasks').where({ task_id: 'anonymous-a' }).update({ initial_job_data: '{invalid', final_result: '{invalid' });
  const items = (await call(routes().getOutcomes)).body.items as Array<Record<string, unknown>>;
  assert.deepEqual(items.map(item => item.eventCount), [2, 2, 1, 1]);
});

test('an untitled latest event keeps the entity title and its own outcome', async () => {
  await seedTask({ taskId: 'named', prNumber: 900, title: 'Handle "retry budget" failures', states: [{ state: 'completed', timestamp: minutesAgo(10) }] });
  await seedTask({ taskId: 'untitled', prNumber: 900, states: [{ state: 'completed', timestamp: minutesAgo(1), metadata: { notificationRecap: 'Fixed remaining checks' } }] });
  await database('tasks').where({ task_id: 'untitled' }).update({ initial_job_data: '{}' });
  const items = (await call(routes().getOutcomes, { search: '"retry budget"' })).body.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].taskId, items[0].title, items[0].detail, items[0].eventCount],
    ['untitled', 'Handle "retry budget" failures', 'Fixed remaining checks', 2]);
});


test('five parents survive many updates and prior recaps keep their own scores and order', async () => {
  for (let parent = 0; parent < 6; parent++) {
    for (let update = 0; update < 4; update++) {
      await seedTask({ taskId: `parent-${parent}-update-${update}`, prNumber: 500 + parent,
        taskType: 'review', title: `Review PR #${500 + parent}: Deliverable ${parent}`,
        states: [{ state: 'completed', timestamp: minutesAgo(parent * 10 + update + 1),
          metadata: { notificationRecap: `Score ${9 - update}/10 · Review pass ${update}` } }],
      });
    }
  }
  const response = await call(routes().getOutcomes, { limit: '5' });
  const items = response.body.items as Array<{ prNumber: number; eventCount: number; earlierUpdates: Array<{ taskId: string; detail: string; score: number }> }>;
  assert.deepEqual(items.map(item => item.prNumber), [500, 501, 502, 503, 504]);
  for (const [parent, item] of items.entries()) {
    assert.equal(item.eventCount, 4);
    assert.deepEqual(item.earlierUpdates.map(update => [update.taskId, update.detail, update.score]),
      [1, 2, 3].map(update => [`parent-${parent}-update-${update}`, `Review pass ${update}`, 9 - update]));
  }
});


test('review metadata survives generic titles, absent scores and later fixes in the same PR', async () => {
  await seedTask({ taskId: 'review-without-score', prNumber: 2587, taskType: 'pr-comment', title: 'Followup: Dashboard cleanup', states: [
    { state: 'processing', timestamp: minutesAgo(20), metadata: { commandMode: 'review' } },
    { state: 'completed', timestamp: minutesAgo(18), metadata: { commandMode: 'review', notificationRecap: '1 reviewer failed' } },
    { state: 'completed', timestamp: minutesAgo(17), metadata: { notificationRecap: 'Completed the pull request follow-up.' } },
  ] });
  await seedTask({ taskId: 'fix', prNumber: 2587, title: 'Followup: Dashboard cleanup', states: [
    { state: 'completed', timestamp: minutesAgo(10), metadata: { notificationRecap: 'Fixed the reported issue.' } },
  ] });
  const items = (await call(routes().getOutcomes, { repository: 'integry/propr', limit: '1' })).body.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0].eventCount, 2);
  const updates = items[0].earlierUpdates as Array<Record<string, unknown>>;
  assert.deepEqual(updates.map(item => [item.taskType, item.score, item.detail]), [['review', null, '1 reviewer failed']]);
});

test('same-millisecond review and fix completions keep distinct IDs, recaps and scores', async () => {
  await seedTask({ taskId: 'reused', prNumber: 2587, taskType: 'pr-comment', title: 'Review PR #2587: Dashboard cleanup', states: [
    { state: 'processing', timestamp: minutesAgo(1) },
    { state: 'completed', timestamp: minutesAgo(1), metadata: { commandMode: 'review', notificationRecap: 'Score 6/10 · 2 issues found' } },
    { state: 'processing', timestamp: minutesAgo(1) },
    { state: 'completed', timestamp: minutesAgo(1), metadata: { commandMode: 'fix', notificationRecap: 'Fixed the review findings.' } },
    { state: 'processing', timestamp: minutesAgo(1) },
    { state: 'completed', timestamp: minutesAgo(1), metadata: { commandMode: 'review', notificationRecap: 'Score 9/10 · 0 issues found' } },
  ] });
  const items = (await call(routes().getOutcomes)).body.items as Array<Record<string, unknown>>;
  const updates = items[0].earlierUpdates as Array<Record<string, unknown>>;
  assert.equal(items[0].eventCount, 3);
  assert.equal(items[0].score, 9);
  assert.deepEqual(updates.map(item => [item.taskType, item.score, item.detail]),
    [['fix', null, 'Fixed the review findings.'], ['review', 6, '2 issues found']]);
  assert.equal(new Set([items[0].id, ...updates.map(item => item.id)]).size, 3);
});

test('title search ranks once per phase even when the Unicode match is beyond 500 parents', async () => {
  for (let index = 0; index < 505; index++) {
    await seedTask({ taskId: `unrelated-${index}`, issueNumber: 10000 + index,
      title: `Unrelated ${index}`, states: [{ state: 'completed', timestamp: minutesAgo(1) }] });
  }
  await seedTask({ taskId: 'unicode-parent', issueNumber: 20000, title: 'Änderung: retry budget',
    states: [{ state: 'completed', timestamp: minutesAgo(30) }] });
  const rankings: string[] = [];
  const observe = ({ sql }: { sql: string }) => {
    if (sql.includes('completion_history')) rankings.push(sql);
  };
  database.on('query', observe);
  try {
    const result = await call(routes().getOutcomes, { search: 'ÄNDERUNG', limit: '1' });
    assert.deepEqual((result.body.items as Array<Record<string, unknown>>).map(row => row.taskId), ['unicode-parent']);
    assert.equal(rankings.length, 2, 'one compact title search and one selected-entity read');
    rankings.length = 0;
    await call(routes().getOutcomes, { limit: '1' });
    assert.equal(rankings.length, 1, 'parents and earlier updates share one ranking');
  } finally {
    database.removeListener('query', observe);
  }
});

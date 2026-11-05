/**
 * The spend behind review quality's cost per merged PR: which tasks a merged
 * pull request's cost is read from, and which later work stays out of it.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Knex } from 'knex';
import { loadPullRequestCosts } from '../routes/reviewScoreSpend.js';
import { createDashboardTestDatabase, daysAgo, seedTask } from './dashboardTestHarness.js';

let database: Knex;
const REPOSITORY = 'integry/propr';
const key = (pr: number) => `${REPOSITORY}#${pr}`;

before(async () => { database = await createDashboardTestDatabase(); });
after(async () => database.destroy());

interface RunSeed { taskId: string; issue: number; pr: number | null; taskType: string; at: string; cost: number }

/** One task that ran once at `at` for `cost` dollars. */
async function seedRun({ taskId, issue, pr, taskType, at, cost }: RunSeed): Promise<void> {
  await seedTask(database, { taskId, issueNumber: issue, prNumber: pr, taskType, states: [{ state: 'completed', timestamp: at }] });
  await database('llm_executions').insert({ task_id: taskId, start_time: at, cost_usd: cost });
}

test('a later implementation of the same issue does not add its cost to the PR merged before it', async () => {
  // The first attempt at issue 600 opened PR 70, merged 18 days ago; a second attempt opened PR 71, merged 11 days ago.
  await seedRun({ taskId: 'impl-600-first', issue: 600, pr: 70, taskType: 'issue', at: daysAgo(20), cost: 5 });
  await seedRun({ taskId: 'impl-600-second', issue: 600, pr: 71, taskType: 'issue', at: daysAgo(13), cost: 20 });
  // A review of PR 70 after its merge still acts on PR 70.
  await seedRun({ taskId: 'review-70', issue: 70, pr: null, taskType: 'review', at: daysAgo(12), cost: 1 });

  const spend = await loadPullRequestCosts(database, [
    { repository: REPOSITORY, prNumber: 70, mergedAt: daysAgo(18) },
    { repository: REPOSITORY, prNumber: 71, mergedAt: daysAgo(11) },
  ]);
  // PR 70: its own attempt and the post-merge review, not the $20 attempt that opened PR 71 a week after its merge.
  assert.deepEqual(spend.get(key(70)), { cost: 6, runs: 1 });
  // PR 71: both attempts at the issue preceded its merge, as the delivery band attaches them.
  assert.deepEqual(spend.get(key(71)), { cost: 25, runs: 2 });

  // With no recorded merge time there is no cutoff: the PR's lifetime spend over every attempt.
  const unbounded = await loadPullRequestCosts(database, [{ repository: REPOSITORY, prNumber: 70, mergedAt: null }]);
  assert.deepEqual(unbounded.get(key(70)), { cost: 26, runs: 3 });
});

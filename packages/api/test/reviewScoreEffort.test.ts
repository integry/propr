import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { up as createPullRequestState } from '../../core/src/db/migrations/20260829010000_add_notification_pull_request_state.js';
import { up as createReviewScores } from '../../core/src/db/migrations/20261006000000_create_review_scores.js';
import { up as addReasoningLevelColumns } from '../../core/src/db/migrations/20261111000000_add_reasoning_level_columns.js';
import { loadReviewScoreSummary, reviewScoreSummaryCsv } from '../routes/reviewScoreStats.js';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 24 * 60 * 60_000).toISOString();
const OPUS = 'claude-opus-5-5';
const GPT = 'gpt-5.6';

let database: Knex;

const memory = (): Knex => knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });

function score(pr: number, value: number, implementer: [model: string | null, effort: string | null], at = daysAgo(3)) {
  const [model, effort] = implementer;
  return {
    repository_id: 'acme/repo', pr_number: pr, task_id: `review-${pr}-${at}`, implementation_task_id: model ? `impl-${pr}` : null,
    implementer_agent: model ? 'agent' : null, implementer_model: model, implementer_reasoning_level: effort,
    reviewer_agent: 'codex', reviewer_model: GPT, score: value, blocker_count: 0, suggestion_count: 0,
    source: 'review', head_sha: `sha-${value}`, created_at: at,
  };
}

before(async () => {
  database = memory();
  await database.schema.createTable('tasks', table => {
    table.string('task_id').primary();
    table.string('repository');
    table.integer('issue_number');
    table.integer('pr_number');
    table.string('task_type');
    table.string('model_name');
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
  await addReasoningLevelColumns(database);

  await database('review_scores').insert([
    // Opus at high effort: PR 1 rose 6 → 9 and merged for $2; PR 2 merged at 8 for $4.
    score(1, 6, [OPUS, 'high'], daysAgo(5)), score(1, 9, [OPUS, 'high'], daysAgo(4)),
    score(2, 8, [OPUS, 'high']),
    // Opus at low effort: PR 3 merged at 5 for $1. PR 4, scored before effort was recorded, closed.
    score(3, 5, [OPUS, 'low']),
    score(4, 7, [OPUS, null]),
    // An empty recorded level is unknown too, never its own bucket.
    score(5, 6, [GPT, '']),
    // Hand-written work has no model and no effort.
    score(6, 4, [null, null]),
  ]);
  await database('notification_pull_request_state').insert([1, 2, 3].map(pr =>
    ({ repository: 'acme/repo', pr_number: pr, merged_at: daysAgo(2), outcome: 'merged', closed_at: daysAgo(2) })));
  await database('notification_pull_request_state').insert({ repository: 'acme/repo', pr_number: 4, merged_at: null, outcome: 'closed', closed_at: daysAgo(2) });
  await database('tasks').insert([1, 2, 3].map(pr =>
    ({ task_id: `impl-${pr}`, repository: 'acme/repo', issue_number: 100 + pr, pr_number: pr, task_type: 'issue', model_name: OPUS, created_at: daysAgo(6) })));
  await database('llm_executions').insert([
    { task_id: 'impl-1', model_name: OPUS, start_time: daysAgo(6), cost_usd: 2 },
    { task_id: 'impl-2', model_name: OPUS, start_time: daysAgo(6), cost_usd: 4 },
    { task_id: 'impl-3', model_name: OPUS, start_time: daysAgo(6), cost_usd: 1 },
  ]);
});

after(async () => database.destroy());

test('groups each model\'s PRs by implementer effort, with unrecorded effort as unknown', async () => {
  const summary = await loadReviewScoreSummary(database, null);
  // Ordered as the per-model rows, then from lowest to highest effort, unknown last; no PR is dropped.
  assert.deepEqual(summary.by_effort.map(row => [row.implementer_model, row.implementer_reasoning_level, row.prs_scored]), [
    [OPUS, 'low', 1], [OPUS, 'high', 2], [OPUS, 'unknown', 1], [GPT, 'unknown', 1], [null, 'unknown', 1],
  ]);
  assert.equal(summary.by_effort.reduce((sum, row) => sum + row.prs_scored, 0), summary.prs_scored);

  const [low, high, unknown] = summary.by_effort;
  assert.deepEqual(high, {
    implementer_model: OPUS,
    implementer_agent: 'agent',
    implementer_reasoning_level: 'high',
    prs_scored: 2,
    first_score: { mean: 7, median: 7, n: 2 },
    final_score: { mean: 8.5, n: 2 },
    cycles_to_goal: { mean: null, n: 0, attempted: 0 },
    merge_rate: { value: 1, merged: 2, n: 2 },
    cost_per_merged_pr: { usd: 3, n: 2 },
    score_delta: { mean: 1.5, n: 2 },
    runs_to_merge: { mean: 1, n: 2 },
  });
  assert.deepEqual(low.cost_per_merged_pr, { usd: 1, n: 1 });
  assert.deepEqual(low.first_score, { mean: 5, median: 5, n: 1 });
  assert.deepEqual(unknown.merge_rate, { value: 0, merged: 0, n: 1 });

  // The per-model totals keep their meaning: every Opus PR, whatever its effort.
  const [opus] = summary.models;
  assert.equal(opus.implementer_model, OPUS);
  assert.equal(opus.prs_scored, 4);
  assert.deepEqual(opus.merge_rate, { value: 0.75, merged: 3, n: 4 });
  assert.deepEqual(opus.cost_per_merged_pr, { usd: 2.3333, n: 3 });
  assert.equal('implementer_reasoning_level' in opus, false);
});

test('the CSV has one row per model and effort, with the effort after the agent', async () => {
  const lines = reviewScoreSummaryCsv(await loadReviewScoreSummary(database, null)).trimEnd().split('\r\n');
  assert.deepEqual(lines[0].split(',').slice(0, 4), ['implementer_model', 'implementer_agent', 'implementer_reasoning_level', 'prs_scored']);
  assert.deepEqual(lines.slice(1).map(line => line.split(',').slice(0, 4).join(',')), [
    `${OPUS},agent,low,1`, `${OPUS},agent,high,2`, `${OPUS},agent,unknown,1`, `${GPT},agent,unknown,1`, ',,unknown,1',
  ]);
});

test('an instance whose scores predate the effort column reports every PR under unknown effort', async () => {
  const legacy = memory();
  try {
    await createPullRequestState(legacy);
    await createReviewScores(legacy);
    const row: Record<string, unknown> = score(1, 6, [OPUS, null]);
    delete row.implementer_reasoning_level;
    await legacy('review_scores').insert(row);
    const summary = await loadReviewScoreSummary(legacy, null);
    assert.deepEqual(summary.by_effort.map(entry => [entry.implementer_model, entry.implementer_reasoning_level, entry.prs_scored]), [[OPUS, 'unknown', 1]]);
  } finally {
    await legacy.destroy();
  }
});

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { up as createPullRequestState } from '../../core/src/db/migrations/20260829010000_add_notification_pull_request_state.js';
import { up as createReviewScores } from '../../core/src/db/migrations/20261006000000_create_review_scores.js';
import { createReviewScoreRoutes, loadReviewScoreSummary, median, reviewScoreSummaryCsv } from '../routes/reviewScoreStats.js';
import { createStatsRoutes } from '../routes/statsRoutes.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 24 * 60 * 60_000).toISOString();

const OPUS = 'claude-opus-5-5';
const GPT = 'gpt-5.6';

let database: Knex;

interface ScoreSeed {
  pr: number;
  score: number;
  at: string;
  model: string | null;
  blockers?: number;
  cycle?: number | null;
  goal?: number | null;
  repository?: string;
}

async function seedScore(seed: ScoreSeed): Promise<void> {
  await database('review_scores').insert({
    repository_id: seed.repository ?? 'acme/repo', pr_number: seed.pr, task_id: `review-${seed.pr}-${seed.at}`,
    implementation_task_id: seed.model ? `impl-${seed.pr}` : null, implementer_agent: seed.model ? 'agent' : null,
    implementer_model: seed.model, reviewer_agent: 'codex', reviewer_model: GPT, score: seed.score,
    blocker_count: seed.blockers ?? 0, suggestion_count: 0, cycle_number: seed.cycle ?? null, goal: seed.goal ?? null,
    source: seed.goal ? 'ultrafix' : 'review', head_sha: `sha-${seed.score}`, created_at: seed.at,
  });
}

before(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('tasks', table => {
    table.string('task_id').primary();
    table.string('repository');
    table.integer('issue_number');
    table.integer('pr_number');
    table.string('task_type');
    table.string('model_name');
    table.text('created_at');
  });
  await database.schema.createTable('task_history', table => {
    table.increments('history_id');
    table.string('task_id');
    table.string('state');
    table.text('timestamp');
  });
  await database.schema.createTable('llm_executions', table => {
    table.increments('execution_id');
    table.string('task_id');
    table.string('model_name');
    table.text('start_time');
    table.decimal('cost_usd', 10, 6);
  });
  await database.schema.createTable('llm_execution_details', table => {
    table.increments('detail_id');
    table.integer('execution_id');
    table.integer('token_count_input');
    table.integer('token_count_output');
  });
  await database.schema.createTable('repositories', table => {
    table.string('full_name');
    table.text('last_indexed_at');
  });
  await createPullRequestState(database);
  await createReviewScores(database);

  // Opus PR 1: Ultrafix from 5 (with a blocker) to a clean 8 at cycle 2, merged, then a stray post-merge review.
  await seedScore({ pr: 1, score: 5, blockers: 1, cycle: 1, goal: 8, at: daysAgo(5), model: OPUS });
  await seedScore({ pr: 1, score: 8, cycle: 2, goal: 8, at: daysAgo(4), model: OPUS });
  await seedScore({ pr: 1, score: 9, at: daysAgo(2), model: OPUS });
  // Opus PR 2: one review, closed unmerged. PR 3: still open; its Ultrafix never reached the goal.
  await seedScore({ pr: 2, score: 7, at: daysAgo(5), model: OPUS });
  await seedScore({ pr: 3, score: 4, blockers: 2, cycle: 1, goal: 9, at: daysAgo(3), model: OPUS });
  // GPT PR 10 merged without any recorded cost; PR 11 merged with cost.
  await seedScore({ pr: 10, score: 6, at: daysAgo(6), model: GPT });
  await seedScore({ pr: 10, score: 8, at: daysAgo(5), model: GPT });
  await seedScore({ pr: 11, score: 9, at: daysAgo(5), model: GPT });
  // A PR whose implementer is unknown.
  await seedScore({ pr: 20, score: 3, at: daysAgo(1), model: null });
  // Outside a 30-day window, and in another repository.
  await seedScore({ pr: 30, score: 2, at: daysAgo(100), model: GPT });
  await seedScore({ pr: 5, score: 10, at: daysAgo(1), model: GPT, repository: 'acme/other' });

  await database('notification_pull_request_state').insert([
    { repository: 'acme/repo', pr_number: 1, merged_at: daysAgo(3), outcome: 'merged', closed_at: daysAgo(3) },
    { repository: 'acme/repo', pr_number: 2, merged_at: null, outcome: 'closed', closed_at: daysAgo(4) },
    { repository: 'acme/repo', pr_number: 3, merged_at: null, outcome: null, closed_at: null },
    { repository: 'acme/repo', pr_number: 10, merged_at: daysAgo(4), outcome: 'merged', closed_at: daysAgo(4) },
    // A merge observed before outcomes were recorded still counts as merged.
    { repository: 'acme/repo', pr_number: 11, merged_at: daysAgo(4), outcome: null, closed_at: null },
  ]);

  await database('tasks').insert([
    { task_id: 'impl-1', repository: 'acme/repo', issue_number: 100, pr_number: 1, task_type: 'issue', model_name: OPUS, created_at: daysAgo(6) },
    { task_id: 'pr-comment-1', repository: 'acme/repo', issue_number: 1, pr_number: null, task_type: 'pr-comment', model_name: GPT, created_at: daysAgo(5) },
    { task_id: 'impl-10', repository: 'acme/repo', issue_number: 110, pr_number: 10, task_type: 'issue', model_name: GPT, created_at: daysAgo(7) },
    { task_id: 'impl-11', repository: 'acme/repo', issue_number: 111, pr_number: 11, task_type: 'issue', model_name: GPT, created_at: daysAgo(7) },
    // Issue 1 is not PR 1: an issue task never adds its cost to the PR with the same number.
    { task_id: 'issue-1', repository: 'acme/repo', issue_number: 1, pr_number: null, task_type: 'issue', model_name: GPT, created_at: daysAgo(7) },
  ]);
  await database('llm_executions').insert([
    { task_id: 'impl-1', model_name: OPUS, start_time: daysAgo(6), cost_usd: 2.25 },
    { task_id: 'pr-comment-1', model_name: GPT, start_time: daysAgo(5), cost_usd: 0.75 },
    { task_id: 'impl-10', model_name: GPT, start_time: daysAgo(7), cost_usd: null },
    { task_id: 'impl-11', model_name: GPT, start_time: daysAgo(7), cost_usd: 5 },
    { task_id: 'issue-1', model_name: GPT, start_time: daysAgo(7), cost_usd: 100 },
  ]);
});

after(async () => database.destroy());

function recorder() {
  const state: { status: number; body: unknown; headers: Record<string, string>; text?: string } = { status: 200, body: undefined, headers: {} };
  const response = {
    status(code: number) { state.status = code; return response; },
    json(body: unknown) { state.body = body; return response; },
    send(text: string) { state.text = text; return response; },
    setHeader(name: string, value: string) { state.headers[name.toLowerCase()] = value; return response; },
  } as unknown as Response;
  return { response, state };
}

async function invoke(handler: (req: Request, res: Response) => Promise<void>, query: Record<string, string> = {}, params: Record<string, string> = {}) {
  const { response, state } = recorder();
  await handler({ query, params } as unknown as Request, response);
  return state;
}

const routes = () => createReviewScoreRoutes({ db: database, now: () => NOW });

test('median handles odd, even and empty inputs', () => {
  assert.equal(median([5, 7, 4]), 5);
  assert.equal(median([6, 9]), 7.5);
  assert.equal(median([]), null);
});

test('summarizes review quality per implementer model with denominators', async () => {
  const state = await invoke(routes().getSummary, { period: '30d', repository: 'acme/repo' });
  assert.equal(state.status, 200);
  const body = state.body as Awaited<ReturnType<typeof loadReviewScoreSummary>>;
  assert.equal(body.period, '30d');
  assert.equal(body.repository, 'acme/repo');
  assert.equal(body.prs_scored, 6);
  assert.equal(body.scores_recorded, 9);
  assert.deepEqual(body.models.map(model => model.implementer_model), [OPUS, GPT, null]);

  const [opus, gpt, unknown] = body.models;
  assert.deepEqual(opus, {
    implementer_model: OPUS,
    implementer_agent: 'agent',
    prs_scored: 3,
    first_score: { mean: 5.33, median: 5, n: 3 },
    // PR 1's final score is the last one before its merge (8), not the post-merge 9.
    final_score: { mean: 6.33, n: 3 },
    cycles_to_goal: { mean: 2, n: 1, attempted: 2 },
    merge_rate: { value: 0.5, merged: 1, n: 2 },
    // Implementation (2.25) plus follow-up (0.75); the same-numbered issue task is not part of it.
    cost_per_merged_pr: { usd: 3, n: 1 },
  });
  assert.deepEqual(gpt, {
    implementer_model: GPT,
    implementer_agent: 'agent',
    prs_scored: 2,
    first_score: { mean: 7.5, median: 7.5, n: 2 },
    final_score: { mean: 8.5, n: 2 },
    cycles_to_goal: { mean: null, n: 0, attempted: 0 },
    merge_rate: { value: 1, merged: 2, n: 2 },
    // PR 10 recorded no cost, so it is left out of the denominator rather than counted as free.
    cost_per_merged_pr: { usd: 5, n: 1 },
  });
  assert.deepEqual(unknown, {
    implementer_model: null,
    implementer_agent: null,
    prs_scored: 1,
    first_score: { mean: 3, median: 3, n: 1 },
    final_score: { mean: 3, n: 1 },
    cycles_to_goal: { mean: null, n: 0, attempted: 0 },
    merge_rate: { value: null, merged: 0, n: 0 },
    cost_per_merged_pr: { usd: null, n: 0 },
  });
});

test('without a period or repository every recorded score counts', async () => {
  const summary = await loadReviewScoreSummary(database, null);
  assert.equal(summary.period, null);
  assert.equal(summary.repository, 'all');
  assert.equal(summary.prs_scored, 8);
  const gpt = summary.models.find(model => model.implementer_model === GPT)!;
  assert.equal(gpt.prs_scored, 4);
  assert.deepEqual(gpt.first_score, { mean: 6.75, median: 7.5, n: 4 });
});

test('rejects an unknown period or malformed repository', async () => {
  assert.equal((await invoke(routes().getSummary, { period: 'forever' })).status, 400);
  assert.equal((await invoke(routes().getSummary, { repository: 'not a repo' })).status, 400);
  assert.equal((await invoke(routes().getCsv, { repository: 'not a repo' })).status, 400);
});

test('exports the same summary as CSV, with unknown values as empty cells', async () => {
  const state = await invoke(routes().getCsv, { period: '30d', repository: 'acme/repo' });
  assert.equal(state.status, 200);
  assert.equal(state.headers['content-type'], 'text/csv; charset=utf-8');
  assert.match(state.headers['content-disposition'], /review-scores-30d\.csv/);
  const lines = state.text!.trimEnd().split('\r\n');
  assert.equal(lines[0], 'implementer_model,implementer_agent,prs_scored,first_score_mean,first_score_median,first_score_n,'
    + 'final_score_mean,final_score_n,cycles_to_goal_mean,cycles_to_goal_n,cycles_to_goal_attempted,merge_rate,merged,merge_rate_n,'
    + 'cost_per_merged_pr_usd,cost_per_merged_pr_n');
  assert.equal(lines[1], `${OPUS},agent,3,5.33,5,3,6.33,3,2,1,2,0.5,1,2,3,1`);
  assert.equal(lines[2], `${GPT},agent,2,7.5,7.5,2,8.5,2,,0,0,1,2,2,5,1`);
  assert.equal(lines[3], ',,1,3,3,1,3,1,,0,0,,0,0,,0');
  assert.equal(lines.length, 4);
});

test('CSV cells are quoted and cannot start a spreadsheet formula', () => {
  const csv = reviewScoreSummaryCsv({
    period: null, repository: 'all', prs_scored: 1, scores_recorded: 1,
    models: [{
      implementer_model: '=HYPERLINK("x")', implementer_agent: 'a,b', prs_scored: 1,
      first_score: { mean: 1, median: 1, n: 1 }, final_score: { mean: 1, n: 1 },
      cycles_to_goal: { mean: null, n: 0, attempted: 0 }, merge_rate: { value: null, merged: 0, n: 0 },
      cost_per_merged_pr: { usd: null, n: 0 },
    }],
  });
  assert.ok(csv.split('\r\n')[1].startsWith(`"'=HYPERLINK(""x"")","a,b",1,`));
});

test('returns one PR\'s score history with its outcome', async () => {
  const state = await invoke(routes().getPullRequestScores, { repository: 'acme/repo' }, { number: '1' });
  assert.equal(state.status, 200);
  const body = state.body as { outcome: string; merged_at: string; scores: Array<Record<string, unknown>> };
  assert.equal(body.outcome, 'merged');
  assert.equal(body.merged_at, daysAgo(3));
  assert.deepEqual(body.scores.map(score => [score.cycle_number, score.score, score.source, score.reviewer_model, score.head_sha]), [
    [1, 5, 'ultrafix', GPT, 'sha-5'],
    [2, 8, 'ultrafix', GPT, 'sha-8'],
    [null, 9, 'review', GPT, 'sha-9'],
  ]);
  const empty = await invoke(routes().getPullRequestScores, { repository: 'acme/repo' }, { number: '404' });
  assert.deepEqual(empty.body, { repository: 'acme/repo', pr_number: 404, outcome: null, merged_at: null, closed_at: null, scores: [] });
  assert.equal((await invoke(routes().getPullRequestScores, { repository: 'acme/repo' }, { number: '1.5' })).status, 400);
  assert.equal((await invoke(routes().getPullRequestScores, {}, { number: '1' })).status, 400);
});

test('the overview\'s model usage carries the mean final score and scored-PR count', async () => {
  const stats = createStatsRoutes({ db: database, now: () => NOW });
  const state = await invoke(stats.getOverview, { period: '30d' });
  assert.equal(state.status, 200);
  const usage = (state.body as { model_usage: Array<{ model: string; mean_final_score: number | null; n_scored: number }> }).model_usage;
  const byModel = Object.fromEntries(usage.map(entry => [entry.model, entry]));
  assert.equal(byModel[OPUS].mean_final_score, 6.33);
  assert.equal(byModel[OPUS].n_scored, 3);
  // Across all repositories in the period: PR 10 (8), PR 11 (9), acme/other PR 5 (10).
  assert.equal(byModel[GPT].mean_final_score, 9);
  assert.equal(byModel[GPT].n_scored, 3);
});

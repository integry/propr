import type { Knex } from 'knex';

/**
 * What happened on a plan issue's pull request after it opened: how many
 * follow-up runs changed it and the review scores it received, oldest first.
 */
export interface PlanIssuePullRequestActivity {
  followupCount: number;
  reviewScores: number[];
}

/** Command modes whose runs read the PR without changing it. */
const NON_FOLLOWUP_COMMAND_MODES = ['review', 'ultrafix'];

const activityKey = (repository: string, prNumber: number) => `${repository}#${prNumber}`;

/**
 * Reads the follow-up runs and review scores of every given PR in two queries.
 *
 * The stored `followup_count` only counts human PR comments seen by the
 * webhook, so it misses Ultrafix fixes and `/fix` runs started by the bot.
 * Counting the recorded PR runs instead covers every follow-up: each fix,
 * comment batch or `/use` run is one task. Reviews, the `/ultrafix` kick-off,
 * merge-conflict runs and superseded attempts are not follow-ups.
 *
 * A review job with several reviewers records one score each; the trace keeps
 * the newest, which is the one the Ultrafix loop judges.
 */
export async function loadPlanIssuePullRequestActivity(
  db: Knex,
  issues: ReadonlyArray<{ repository: string; pr_number: number | null }>,
): Promise<Map<string, PlanIssuePullRequestActivity>> {
  const activity = new Map<string, PlanIssuePullRequestActivity>();
  const prsByRepository = new Map<string, Set<number>>();
  for (const issue of issues) {
    if (!issue.pr_number) continue;
    const prs = prsByRepository.get(issue.repository) ?? new Set<number>();
    prs.add(issue.pr_number);
    prsByRepository.set(issue.repository, prs);
  }
  if (prsByRepository.size === 0) return activity;

  const forEachPullRequest = (query: Knex.QueryBuilder, repositoryColumn: string, prColumn: string) =>
    query.where(scope => {
      for (const [repository, prs] of prsByRepository) {
        scope.orWhere(inner => inner.where(repositoryColumn, repository).whereIn(prColumn, [...prs]));
      }
    });

  const safeJson = "CASE WHEN json_valid(initial_job_data) THEN initial_job_data ELSE '{}' END";
  const [followups, scores] = await Promise.all([
    forEachPullRequest(db('tasks'), 'repository', 'issue_number')
      .where(query => query.where('task_type', 'pr-comment')
        .orWhere('task_id', 'like', 'pr-comment-%')
        .orWhere('task_id', 'like', 'pr-comments-%'))
      .whereNotIn('task_type', ['review', 'merge_conflict', 'goal'])
      .whereNull('replaced_by_task_id')
      .where(query => query.whereRaw(`json_extract(${safeJson}, '$.commandMode') IS NULL`)
        .orWhereRaw(`json_extract(${safeJson}, '$.commandMode') NOT IN (${NON_FOLLOWUP_COMMAND_MODES.map(() => '?').join(', ')})`,
          NON_FOLLOWUP_COMMAND_MODES))
      .groupBy('repository', 'issue_number')
      .select('repository', 'issue_number')
      .count({ count: '*' }) as Promise<Array<{ repository: string; issue_number: number; count: number | string }>>,
    forEachPullRequest(db('review_scores'), 'repository_id', 'pr_number')
      .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }])
      .select('repository_id', 'pr_number', 'task_id', 'score') as Promise<Array<{
        repository_id: string; pr_number: number; task_id: string; score: number;
      }>>,
  ]);

  const entry = (repository: string, prNumber: number) => {
    const key = activityKey(repository, prNumber);
    let found = activity.get(key);
    if (!found) activity.set(key, found = { followupCount: 0, reviewScores: [] });
    return found;
  };
  for (const row of followups) entry(row.repository, Number(row.issue_number)).followupCount = Number(row.count);

  // Rows arrive oldest first, so a review job keeps its first position and its newest reviewer's score.
  const scoresByJob = new Map<string, Map<string, number>>();
  for (const row of scores) {
    const key = activityKey(row.repository_id, Number(row.pr_number));
    entry(row.repository_id, Number(row.pr_number));
    const jobs = scoresByJob.get(key) ?? new Map<string, number>();
    jobs.set(row.task_id, Number(row.score));
    scoresByJob.set(key, jobs);
  }
  for (const [key, jobs] of scoresByJob) activity.get(key)!.reviewScores = [...jobs.values()];
  return activity;
}

/**
 * The issue as the planner shows it: the follow-up count recorded on the PR,
 * never fewer than the comments the webhook counted, and its review scores.
 */
export function withPullRequestActivity<T extends { repository: string; pr_number: number | null; followup_count: number }>(
  issue: T,
  activity: Map<string, PlanIssuePullRequestActivity>,
): T & { review_scores: number[] } {
  const found = issue.pr_number ? activity.get(activityKey(issue.repository, issue.pr_number)) : undefined;
  return {
    ...issue,
    followup_count: Math.max(issue.followup_count || 0, found?.followupCount ?? 0),
    review_scores: found?.reviewScores ?? [],
  };
}

/** Issues with the follow-ups and review scores recorded on their PRs. */
export async function withRecordedPullRequestActivity<T extends { repository: string; pr_number: number | null; followup_count: number }>(
  db: Knex,
  issues: T[],
): Promise<Array<T & { review_scores: number[] }>> {
  // The activity is supplementary; a failed read leaves the stored follow-up count in place.
  const activity = await loadPlanIssuePullRequestActivity(db, issues).catch((error: unknown) => {
    console.warn('Failed to load plan issue pull request activity:', error);
    return new Map<string, PlanIssuePullRequestActivity>();
  });
  return issues.map((issue) => withPullRequestActivity(issue, activity));
}

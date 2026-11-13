/**
 * A GitHub App fake for readiness evaluations: it answers only the reads the
 * evaluation performs and records every call, so a write would be visible.
 */
import type { Knex } from 'knex';
import type { PullRequestReadinessDeps } from '@propr/core';

export const READY_HEAD = 'a'.repeat(40);

export function appIdentityFake(pulls: Record<number, Record<string, unknown>>) {
  const calls: string[] = [];
  const octokit = {
    async request(route: string, params: Record<string, unknown> = {}) {
      calls.push(route);
      const pull = pulls[Number(params.pull_number)];
      switch (route) {
        case 'GET /repos/{owner}/{repo}/pulls/{pull_number}':
          if (!pull) throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: pull };
        case 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': return { data: [{ state: 'APPROVED', user: { login: 'maintainer' } }] };
        case 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': return { data: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] } };
        case 'GET /repos/{owner}/{repo}/commits/{ref}/status': return { data: { state: 'success', total_count: 1, statuses: [{ context: 'legacy', state: 'success' }] } };
        default: throw new Error(`unexpected App call ${route}`);
      }
    },
    async graphql<T>(): Promise<T> {
      calls.push('graphql');
      return { repository: { pullRequest: { reviewDecision: 'APPROVED' } } } as T;
    },
  };
  return { octokit, calls };
}

export function readyPull(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number, state: 'open', merged: false, draft: false, body: '', head: { sha: READY_HEAD, ref: 'feature' }, base: { ref: 'main' },
    labels: [], mergeable: true, mergeable_state: 'clean', auto_merge: null, ...overrides,
  };
}

/** Everything but the App client and score loader, as the evaluation's read-only stand-ins. */
export const readOnlyStandIns: Omit<PullRequestReadinessDeps, 'loadReviewScores'> = {
  observations: { get: async () => null },
  loadNonBlockingChecks: async () => [],
  loadUltrafixState: async () => null,
  loadActiveWork: async () => ({ activeTasks: [], queuedJobs: [] }),
  loadRatingGoal: async () => 8,
  now: () => Date.parse('2026-11-12T12:00:00.000Z'),
};

export async function seedReviewScore(db: Knex, repository: string, prNumber: number, values: { score: number; goal?: number; goalReached?: boolean; head?: string }): Promise<void> {
  await db('review_scores').insert({
    repository_id: repository, pr_number: prNumber, task_id: `review-${prNumber}`, score: values.score, source: values.goal ? 'ultrafix' : 'review',
    goal: values.goal ?? null, goal_reached: values.goalReached ?? null, head_sha: values.head ?? READY_HEAD, created_at: '2026-11-12T11:00:00.000Z',
  });
}

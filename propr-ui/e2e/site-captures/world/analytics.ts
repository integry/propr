import { area } from '../lib/world';
import { NOW, REPOS } from './base';

/** Thirty days of a four-repo team: ~9 tasks a day, most merged after one or two runs. */
const days = 30;
const dailyCounts = Array.from({ length: days }, (_, index) => {
  const date = new Date(NOW.getTime() - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
  const weekday = new Date(date).getUTCDay();
  const count = weekday === 0 || weekday === 6 ? 2 + (index % 3) : 8 + ((index * 5) % 6);
  return { date, count, runs: Math.round(count * 2.1) };
});
const totalTasks = dailyCounts.reduce((sum, day) => sum + day.count, 0);
const totalRuns = dailyCounts.reduce((sum, day) => sum + day.runs, 0);

const figures = (prs: number, first: number, final: number, merged: number, runs: number) => ({
  prs_scored: prs,
  first_score: { mean: first, median: Math.round(first), n: prs },
  final_score: { mean: final, n: prs },
  cycles_to_goal: { mean: 1.6, n: Math.round(prs / 2), attempted: prs },
  merge_rate: { value: merged / prs, merged, n: prs },
  cost_per_merged_pr: { usd: null, n: 0 },
  score_delta: { mean: final - first, n: prs },
  runs_to_merge: { mean: runs, n: merged },
});

export const analytics = area('analytics', {
  '/api/stats/tasks': {
    dailyCounts,
    statusDistribution: [
      { status: 'completed', count: 196 },
      { status: 'failed', count: 11 },
      { status: 'processing', count: 3 },
    ],
    avgProcessingTime: [],
    summary: { total: totalTasks, completed: 196, failed: 11 },
  },
  '/api/stats/repositories': {
    repositories: [
      { repository: REPOS.web, total: 92, completed: 86, failed: 5, inProgress: 1, successRate: 93.5 },
      { repository: REPOS.api, total: 71, completed: 67, failed: 3, inProgress: 1, successRate: 94.4 },
      { repository: REPOS.mobile, total: 34, completed: 31, failed: 2, inProgress: 1, successRate: 91.2 },
      { repository: REPOS.infra, total: 13, completed: 12, failed: 1, inProgress: 0, successRate: 92.3 },
    ],
  },
  '/api/stats/review-scores': {
    period: '30d', repository: 'all', prs_scored: 148, scores_recorded: 311,
    models: [
      { implementer_model: 'claude-opus-5-5', implementer_agent: 'claude', ...figures(71, 7.1, 8.7, 66, 1.9) },
      { implementer_model: 'gpt-6-astra', implementer_agent: 'codex', ...figures(52, 6.8, 8.4, 46, 2.2) },
      { implementer_model: 'antigravity-gemini-3.1-pro', implementer_agent: 'antigravity', ...figures(25, 6.2, 8.1, 20, 2.6) },
    ],
  },
  '/api/stats/overview': {
    tasks: { completed: 196, planned: 14, pr_iterations_avg: 1.6, merged_prs: 132, total_followups: 41 },
    usage: {
      total_tokens: 412_000_000, input_tokens: 398_000_000, output_tokens: 14_000_000, total_cost_usd: 0,
      models: { 'claude-opus-5-5': 98, 'gpt-6-astra': 76, 'antigravity-gemini-3.1-pro': 36 },
      cache: { input_tokens: 398_000_000, cache_read_tokens: 341_000_000, hit_rate: 0.857, saved_usd: 2140 },
    },
    model_usage: [
      { model: 'claude-opus-5-5', runs: 201, tasks: 98, tokens: 214_000_000, cost_usd: 0, mean_final_score: 8.7, n_scored: 71 },
      { model: 'gpt-6-astra', runs: 163, tasks: 76, tokens: 139_000_000, cost_usd: 0, mean_final_score: 8.4, n_scored: 52 },
      { model: 'antigravity-gemini-3.1-pro', runs: totalRuns - 364, tasks: 36, tokens: 59_000_000, cost_usd: 0, mean_final_score: 8.1, n_scored: 25 },
    ],
    runs: { total: totalRuns, tasks: totalTasks, per_task: totalRuns / totalTasks },
    delivery: {
      prs_opened: 148, prs_merged: 132, prs_closed: 9,
      first_time_pass: { rate: 0.64, passed: 84, n: 132 },
      time_to_merge_minutes: { mean: 196, median: 142, n: 132 },
      runs_per_merged_pr: { mean: 2.1, n: 132 },
    },
    autonomy: { rate: 0.88, autonomous: 182, operator: 25, n: 207 },
    system: { repos_indexed: 4 },
  },
});

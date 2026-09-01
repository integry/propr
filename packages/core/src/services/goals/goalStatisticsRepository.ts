import type { Knex } from 'knex';
import type { GoalNodeRecord, GoalStatistics } from './goalTypes.js';
import { GoalReadRepository } from './goalReadRepository.js';
import { requireGoalRecord } from './goalRepositorySupport.js';

interface UsageGroup {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export class GoalStatisticsRepository {
  constructor(private readonly db: Knex) {}

  async get(goalId: string): Promise<GoalStatistics> {
    const goal = await requireGoalRecord(this.db, goalId);
    const timing = await new GoalReadRepository(this.db).getActiveTimeStats(goalId);
    const enhanced = await this.db.schema.hasTable('goal_external_projections');
    // Foundation-only databases retain the original read model. Full migration
    // chains expose the expanded deterministic aggregate below.
    if (!enhanced) return timing as GoalStatistics;
    const nodes = await this.db<GoalNodeRecord>('goal_nodes').where('goal_id', goalId);
    const dependencies = await this.db('goal_node_dependencies').where('goal_id', goalId);
    const completed = new Set(nodes.filter(node => node.status === 'completed').map(node => node.node_id));
    const dependencyMap = new Map<string, string[]>();
    for (const edge of dependencies) {
      const current = dependencyMap.get(edge.node_id) ?? [];
      current.push(edge.depends_on_node_id);
      dependencyMap.set(edge.node_id, current);
    }
    const issues = nodes.filter(node => node.kind === 'implementation_issue');
    const issueStats = {
      total: issues.length,
      ready: issues.filter(node => node.status === 'pending'
        && (dependencyMap.get(node.node_id) ?? []).every(id => completed.has(id))).length,
      active: issues.filter(node => node.status === 'in_progress').length,
      processed: issues.filter(node => node.status === 'completed').length,
      failed: issues.filter(node => node.status === 'failed').length,
      blocked: issues.filter(node => node.status === 'blocked').length,
    };

    const external = enhanced
      ? await this.db('goal_external_projections').where('goal_id', goalId)
      : [];
    const pullRequests = new Map<number, string>();
    const statuses = new Map<string, string>();
    for (const row of external) {
      statuses.set(`${row.entity_type}:${row.entity_number}`, row.status);
      if (row.entity_type === 'pull_request') pullRequests.set(row.entity_number, row.status);
    }
    for (const node of nodes.filter(item => item.kind === 'implementation_pr')) {
      const number = Number(node.external_ref);
      if (Number.isSafeInteger(number) && !pullRequests.has(number)) {
        pullRequests.set(number, node.status === 'completed' ? 'merged' : 'open');
      }
    }
    let reviewPending = 0;
    let ultrafixPending = 0;
    let mergeReady = 0;
    for (const [number, status] of pullRequests) {
      if (status === 'merged') continue;
      const review = statuses.get(`review:${number}`);
      const ultrafix = statuses.get(`ultrafix:${number}`);
      const ci = statuses.get(`ci:${number}`);
      if (review && !['approved', 'complete', 'passed'].includes(review)) reviewPending += 1;
      if (ultrafix && !['complete', 'passed', 'not_required'].includes(ultrafix)) ultrafixPending += 1;
      if (status === 'merge_ready'
        || ci === 'success' && review === 'approved'
          && (!ultrafix || ['complete', 'passed', 'not_required'].includes(ultrafix))) mergeReady += 1;
    }
    const prStats = {
      open: [...pullRequests.values()].filter(status => status !== 'merged').length,
      reviewPending,
      ultrafixPending,
      mergeReady,
      merged: [...pullRequests.values()].filter(status => status === 'merged').length,
    };

    const usage = await this.readUsage(goalId, enhanced);
    const byProviderModel = usage.map(row => ({
      provider: row.provider, model: row.model,
      input: Number(row.input), output: Number(row.output),
      cacheRead: Number(row.cacheRead), cacheWrite: Number(row.cacheWrite),
      reasoning: Number(row.reasoning),
      total: Number(row.input) + Number(row.output),
    }));
    const tokenTotals = byProviderModel.reduce((total, row) => ({
      input: total.input + row.input, output: total.output + row.output,
      cacheRead: total.cacheRead + row.cacheRead, cacheWrite: total.cacheWrite + row.cacheWrite,
      reasoning: total.reasoning + row.reasoning, total: total.total + row.total,
    }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 });
    const sessions = await this.db('goal_provider_sessions').where('goal_id', goalId)
      .select('agent', 'effective_model');
    const providerActive = ['planning', 'running', 'recovering', 'completing'].includes(goal.state);

    return {
      ...timing,
      activeMs: Math.max(0, timing.elapsedMs - timing.pausedMs - timing.recoveryMs),
      issues: issueStats,
      pullRequests: prStats,
      tokens: { ...tokenTotals, byProviderModel },
      activeProviders: providerActive ? [...new Set(sessions.map(row => String(row.agent)))].sort() : [],
      activeModels: providerActive ? [...new Set(sessions.map(row => String(row.effective_model)))].sort() : [],
      controllerState: goal.state,
    };
  }

  private async readUsage(goalId: string, enhanced: boolean): Promise<UsageGroup[]> {
    if (!enhanced || !await this.db.schema.hasTable('goal_usage_occurrences')) return [];
    const rows = await this.db('goal_usage_occurrences').where('goal_id', goalId)
      .groupBy('provider', 'model')
      .select('provider', 'model')
      .sum({
        input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_tokens',
        cacheWrite: 'cache_write_tokens', reasoning: 'reasoning_tokens',
      });
    return rows as UsageGroup[];
  }
}

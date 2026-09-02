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
    const external = enhanced
      ? await this.db('goal_external_projections').where('goal_id', goalId)
      : [];
    const associations = buildAssociationStats(nodes, external);

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
      issues: associations.issues,
      pullRequests: associations.pullRequests,
      tokens: { ...tokenTotals, byProviderModel },
      activeProviders: providerActive ? [...new Set(sessions.map(row => String(row.agent)))].sort() : [],
      activeModels: providerActive ? [...new Set(sessions.map(row => String(row.effective_model)))].sort() : [],
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

function buildAssociationStats(nodes: GoalNodeRecord[], external: Array<Record<string, unknown>>) {
  const issues = new Set<number>();
  const pullRequests = new Map<number, string>();
  for (const row of external) {
    if (row.entity_type === 'issue') issues.add(Number(row.entity_number));
    if (row.entity_type === 'pull_request') pullRequests.set(Number(row.entity_number), String(row.status));
  }
  for (const node of nodes) {
    const number = Number(node.external_ref);
    if (!Number.isSafeInteger(number)) continue;
    if (node.external_kind === 'issue' || node.kind === 'implementation_issue') issues.add(number);
    if ((node.external_kind === 'pull_request' || node.kind === 'implementation_pr') && !pullRequests.has(number)) {
      pullRequests.set(number, 'associated');
    }
  }
  return {
    issues: { total: issues.size },
    pullRequests: {
      total: pullRequests.size,
      open: [...pullRequests.values()].filter(status => status !== 'merged' && status !== 'closed').length,
      merged: [...pullRequests.values()].filter(status => status === 'merged').length,
    },
  };
}

import { z } from 'zod';
import { ANALYTICS_TIMEFRAMES, analyticsTimeframeStart } from '@propr/shared';
import type { McpPrincipal } from './policy.js';
import type { Args, McpTool, ToolDeps } from './tools.js';
import { ok, repositorySchema } from './tools.js';
import { COST_GROUP_KEYS, DEFAULT_COST_GROUP_BY, loadCostExport } from '../routes/costExport.js';

type ListScope = (principal: McpPrincipal, args: Args) => Promise<string[] | null>;

/** Read-only analytics: the same data as the `/api/stats/*` exports, scoped to the grant. */
export function addStatsTools(tools: McpTool[], deps: ToolDeps, listScope: ListScope, now: () => Date = () => new Date()): void {
  tools.push({
    name: 'get_cost_breakdown',
    description: 'Export recorded LLM cost grouped by day, repository, agent, model, reasoning_level, execution_type and/or outcome (success/failed): executions, tasks, input/output/cache tokens and cost in USD per row, plus totals. The same rows as GET /api/stats/cost. Omit repository to cover every repository in this grant; executions without a task are not attributable to a repository and are left out. cost_usd is null when no execution in a row recorded a cost.',
    scope: 'read',
    readOnly: true,
    schema: z.object({
      period: z.enum(ANALYTICS_TIMEFRAMES).default('30d').describe('Executions started in this window; `all` for all time.'),
      repository: repositorySchema.optional().describe('Exact repository handle. Omit to cover every repository in this grant.'),
      groupBy: z.array(z.enum(COST_GROUP_KEYS)).max(COST_GROUP_KEYS.length).default([...DEFAULT_COST_GROUP_BY])
        .describe('Grouping dimensions; rows come back in column order whatever order is given. Empty returns only totals.'),
    }).strict(),
    run: async ({ principal, args }) => {
      const current = now();
      const window = { timeframe: args.period, from: analyticsTimeframeStart(args.period, current), to: current };
      const scope = args.repository
        ? { repository: args.repository as string }
        : { repositories: await listScope(principal, args) ?? [] };
      const costExport = await loadCostExport(deps.db, window, args.groupBy, scope);
      return ok({ ...costExport, repositories: scope.repositories ?? [args.repository] });
    },
  });
}

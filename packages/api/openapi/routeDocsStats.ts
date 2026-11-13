import { z } from 'zod';
import { ANALYTICS_TIMEFRAMES } from '@propr/shared';
import { COST_GROUP_KEYS } from '../routes/costExport.js';
import { component, querySet } from './schemas.js';
import type { RouteDoc } from './types.js';

const count = z.number().int().nonnegative();

const costFigures = {
  executions: count.describe('Agent executions in the row.'),
  tasks: count.describe('Distinct tasks with at least one execution in the row.'),
  input_tokens: count.describe('Input tokens, cache reads and writes included, as each execution was priced.'),
  output_tokens: count,
  cache_creation_input_tokens: count.describe('Of `input_tokens`, prompt-cache writes.'),
  cache_read_input_tokens: count.describe('Of `input_tokens`, prompt-cache reads.'),
  cost_usd: z.number().nonnegative().nullable().describe('Recorded cost in USD; null when no execution in the row recorded a cost.'),
};

const dimension = (description: string) => z.string().nullable().optional().describe(`${description} Present when grouped by it; null when unrecorded.`);

export const CostFigures = component('CostFigures', z.object(costFigures), 'Execution, task, token and cost totals.');

export const CostRow = component('CostRow', z.object({
  day: dimension('UTC day the execution started, `YYYY-MM-DD`.'),
  repository: dimension('`owner/repo` of the execution\'s task.'),
  agent: dimension('Agent alias that ran the execution.'),
  model: dimension('Model name.'),
  reasoning_level: dimension('Effective reasoning level (effort).'),
  execution_type: dimension('Execution type, for example `implementation` or `review`.'),
  outcome: z.enum(['success', 'failed']).optional().describe('Present when grouped by outcome.'),
  ...costFigures,
}), 'One group of recorded executions.');

export const CostExport = component('CostExport', z.object({
  period: z.enum(ANALYTICS_TIMEFRAMES).nullable().describe('The requested period; null for all time.'),
  repository: z.string().describe('`all` or `owner/repo`.'),
  group_by: z.array(z.enum(COST_GROUP_KEYS)).describe('The grouping dimensions, in column order.'),
  rows: z.array(CostRow).describe('Ascending by each dimension in column order; unrecorded values last.'),
  totals: CostFigures,
}), 'Recorded LLM executions grouped by the requested dimensions.');

export const CostExportQuery = querySet('CostExportQuery', z.object({
  period: z.enum(ANALYTICS_TIMEFRAMES).optional().describe('Bounds executions by when they started; omitted means all time.'),
  repository: z.string().optional().describe('`owner/repo`, or `all` (default).'),
  group_by: z.string().optional().describe(`Comma-separated list of ${COST_GROUP_KEYS.map(key => `\`${key}\``).join(', ')}; defaults to \`day\`.`),
}));

const COST_DESCRIPTION = 'One row per group of agent executions (`llm_executions`) started in the period. Repository comes from the execution\'s task; agent and execution type from the matching LLM log call. Executions without a task have no repository and are left out when filtering by repository.';

export const STATS_ROUTE_DOCS: Record<string, RouteDoc> = {
  'GET /api/stats/cost': {
    operationId: 'getCostExport',
    summary: 'Export LLM cost grouped by day, repository, agent, model, effort, execution type or outcome',
    description: COST_DESCRIPTION,
    tags: ['Observability'],
    query: CostExportQuery,
    responses: {
      200: { description: 'The grouped rows and their totals.', schema: CostExport },
      400: { description: '`period`, `repository` or `group_by` is invalid.' },
    },
  },
  'GET /api/stats/cost.csv': {
    operationId: 'getCostExportCsv',
    summary: 'Export LLM cost as CSV',
    description: `${COST_DESCRIPTION} A header row, then one row per group: the grouped dimensions in column order, then executions, tasks, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd. Unknown values are empty cells.`,
    tags: ['Observability'],
    query: CostExportQuery,
    responses: {
      200: { description: 'RFC 4180 CSV attachment.', contentType: 'text/csv' },
      400: { description: '`period`, `repository` or `group_by` is invalid.' },
    },
  },
};

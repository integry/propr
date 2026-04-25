import { Request, Response } from 'express';
import { Knex } from 'knex';
import { validatePagination, validateUUID, validateBoolean } from './validation.js';
import { WORK_TYPES } from '@propr/core';

interface LlmLogsRoutesDeps {
  db: Knex;
}

interface LlmLogRow {
  log_id: number;
  execution_type: string;
  model_name: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_ms: number | null;
  success: boolean | number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cost_usd: number | string | null;
  error_message: string | null;
  session_id: string | null;
  correlation_id: string | null;
  draft_id: string | null;
  repository: string | null;
  agent_alias: string | null;
  metadata: string | null;
  usage_metrics: string | null;
  work_type: string | null;
  task_id: string | null;
  task_number: number | null;
  pr_number: number | null;
  plan_draft_id: string | null;
  plan_issue_id: number | null;
  work_repository: string | null;
}

interface CountRow {
  count: number | string;
}

interface LlmLogFilters {
  executionType?: string;
  model?: string;
  success?: boolean;
  draftId?: string;
  agentAlias?: string;
  workType?: string;
}

function applyLlmLogFilters<T extends Knex.QueryBuilder>(query: T, filters: LlmLogFilters): T {
  if (filters.executionType) {
    query = query.where('execution_type', filters.executionType) as T;
  }
  if (filters.model) {
    query = query.where('model_name', filters.model) as T;
  }
  if (filters.success !== undefined) {
    query = query.where('success', filters.success) as T;
  }
  if (filters.draftId) {
    query = query.where('draft_id', filters.draftId) as T;
  }
  if (filters.agentAlias) {
    query = query.where('agent_alias', filters.agentAlias) as T;
  }
  if (filters.workType) {
    query = query.where('work_type', filters.workType) as T;
  }
  return query;
}

interface UsageMetricRecordRow {
  id: number;
  llm_log_id: number;
  agent_name: string;
  metric_key: string;
  metric_value: number | string;
  created_at: string;
}

/**
 * Infer work reference fields from existing row data when work_type columns
 * are not populated (e.g. pre-migration rows or migration not yet applied).
 *
 * Heuristics:
 * - execution_type determines the work type (implementation/task-analysis → task,
 *   plan-generation/plan-refinement → plan, otherwise → repository)
 * - draft_id often encodes the issue number in a structured format like
 *   "{owner}-{repo}-{number}-{agent}-{model}-{uuid}". We use the repository
 *   field to anchor the prefix and extract the number.
 */
function inferWorkReference(row: LlmLogRow): {
  workType: string | null;
  taskId: string | null;
  taskNumber: number | null;
  planDraftId: string | null;
  workRepository: string | null;
} {
  const execType = row.execution_type;
  const repo = row.repository || null;

  // Determine work type from execution_type
  const isPlan = execType === 'plan-generation' || execType === 'plan-refinement'
    || execType === 'title-generation';
  const isTask = execType === 'implementation' || execType === 'task-analysis'
    || execType === 'context-analysis' || execType === 'pr-review';

  let workType: string | null = null;
  if (isPlan) {
    workType = 'plan';
  } else if (isTask) {
    workType = 'task';
  } else if (repo) {
    workType = 'repository';
  }

  // Try to extract issue number from draft_id using the repository as anchor
  let taskNumber: number | null = null;
  const draftId = row.draft_id;
  if (draftId && repo) {
    // Convert "owner/repo" → "owner-repo-" prefix
    const prefix = repo.replace('/', '-') + '-';
    if (draftId.startsWith(prefix)) {
      const afterPrefix = draftId.substring(prefix.length);
      const match = afterPrefix.match(/^(\d+)-/);
      if (match) {
        taskNumber = parseInt(match[1], 10);
      }
    }
  }

  return {
    workType,
    taskId: isTask ? (draftId || null) : null,
    taskNumber: isTask ? taskNumber : null,
    planDraftId: isPlan ? (draftId || null) : null,
    workRepository: repo,
  };
}

function formatLlmLogRow(
  row: LlmLogRow,
  metricRecords?: UsageMetricRecordRow[],
): Record<string, unknown> {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      // If parsing fails, keep as null
    }
  }

  const formattedRecords = metricRecords
    ? metricRecords.map(r => ({
        agent: r.agent_name,
        metricKey: r.metric_key,
        metricValue: Number(r.metric_value),
      }))
    : [];

  // Use stored work reference if available, otherwise infer from existing fields
  const hasWorkRef = !!(row.work_type);
  const inferred = hasWorkRef ? null : inferWorkReference(row);

  return {
    logId: row.log_id,
    executionType: row.execution_type,
    modelName: row.model_name,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMs: row.duration_ms,
    success: Boolean(row.success),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    costUsd: row.cost_usd ? Number(row.cost_usd) : null,
    errorMessage: row.error_message,
    sessionId: row.session_id,
    correlationId: row.correlation_id,
    draftId: row.draft_id,
    repository: row.repository,
    agentAlias: row.agent_alias,
    metadata,
    usageMetrics: row.usage_metrics ? (() => { try { return JSON.parse(row.usage_metrics); } catch { return null; } })() : null,
    usageMetricRecords: formattedRecords,
    workType: row.work_type || inferred?.workType || null,
    taskId: row.task_id || inferred?.taskId || null,
    taskNumber: row.task_number ?? inferred?.taskNumber ?? null,
    prNumber: row.pr_number ?? null,
    planDraftId: row.plan_draft_id || inferred?.planDraftId || null,
    planIssueId: row.plan_issue_id ?? null,
    workRepository: row.work_repository || inferred?.workRepository || null,
  };
}

async function fetchMetricRecordsByLogId(
  db: Knex,
  logIds: number[],
): Promise<Record<number, UsageMetricRecordRow[]>> {
  const result: Record<number, UsageMetricRecordRow[]> = {};
  if (logIds.length === 0) return result;

  try {
    const allRecords = await db('usage_metric_records')
      .whereIn('llm_log_id', logIds)
      .select('*') as UsageMetricRecordRow[];
    for (const rec of allRecords) {
      const lid = rec.llm_log_id;
      if (!result[lid]) result[lid] = [];
      result[lid].push(rec);
    }
  } catch {
    // Table may not exist yet if migration hasn't run
  }

  return result;
}

export function createLlmLogsRoutes(deps: LlmLogsRoutesDeps) {
  const { db } = deps;

  /** Process-wide cache for work-ref column existence. Only caches `true`
   *  so a process started before the migration will re-check until it lands. */
  let hasWorkRefColumnsCache = false;

  async function checkWorkRefColumns(): Promise<boolean> {
    if (hasWorkRefColumnsCache) return true;
    try {
      const result = await db.schema.hasColumn('llm_logs', 'work_type');
      if (result) hasWorkRefColumnsCache = true;
      return result;
    } catch {
      return false;
    }
  }

  async function getLlmLogs(req: Request, res: Response): Promise<void> {
    try {
      // Validate pagination parameters
      const paginationResult = validatePagination(req.query.page, req.query.limit, { maxLimit: 100, defaultLimit: 50 });
      if (!paginationResult.valid) {
        res.status(400).json({ error: paginationResult.error });
        return;
      }
      const { page, limit, offset } = paginationResult.params!;

      // Parse and validate filter parameters
      const executionType = req.query.execution_type as string | undefined;
      const model = req.query.model as string | undefined;
      const success = req.query.success as string | undefined;
      const draftId = req.query.draft_id as string | undefined;
      const agentAlias = req.query.agent_alias as string | undefined;
      const workType = req.query.work_type as string | undefined;

      // Validate work_type if provided
      if (workType && !(WORK_TYPES as readonly string[]).includes(workType)) {
        res.status(400).json({ error: `work_type must be one of: ${WORK_TYPES.join(', ')}` });
        return;
      }

      // Validate draft_id if provided
      if (draftId) {
        const draftIdValidation = validateUUID(draftId, 'Draft ID');
        if (!draftIdValidation.valid) {
          res.status(400).json({ error: draftIdValidation.error });
          return;
        }
      }

      // Validate success parameter if provided
      if (success !== undefined && success !== '') {
        const successValidation = validateBoolean(success);
        if (!successValidation.valid) {
          res.status(400).json({ error: 'success parameter must be true or false' });
          return;
        }
      }

      // Build filters object
      const filters: LlmLogFilters = {
        executionType,
        model,
        success: success !== undefined ? (success === 'true' || success === '1') : undefined,
        draftId,
        agentAlias,
        workType,
      };

      // Check if work-reference columns exist (cached after first successful check)
      const hasWorkRefColumns = await checkWorkRefColumns();

      // Build and execute queries
      const baseColumns = [
        'log_id', 'execution_type', 'model_name', 'start_time', 'end_time',
        'duration_ms', 'success', 'input_tokens', 'output_tokens',
        'cache_creation_input_tokens', 'cache_read_input_tokens', 'cost_usd',
        'error_message', 'session_id', 'correlation_id', 'draft_id',
        'repository', 'agent_alias', 'metadata', 'usage_metrics',
      ];
      const workRefColumns = [
        'work_type', 'task_id', 'task_number', 'pr_number',
        'plan_draft_id', 'plan_issue_id', 'work_repository',
      ];
      const selectColumns = hasWorkRefColumns
        ? [...baseColumns, ...workRefColumns]
        : baseColumns;

      const baseQuery = db('llm_logs').select(...selectColumns);

      const countQuery = db('llm_logs').count('* as count');

      // If work_type filter is requested but the column doesn't exist, return empty results
      if (!hasWorkRefColumns && workType) {
        res.json({
          logs: [],
          pagination: { total: 0, page, limit, totalPages: 0 },
        });
        return;
      }

      // Only apply work_type filter if the column exists
      const effectiveFilters = hasWorkRefColumns
        ? filters
        : { ...filters, workType: undefined };

      const [logs, countResult] = await Promise.all([
        applyLlmLogFilters(baseQuery, effectiveFilters)
          .orderBy('start_time', 'desc')
          .limit(limit)
          .offset(offset) as unknown as Promise<LlmLogRow[]>,
        applyLlmLogFilters(countQuery, effectiveFilters).first() as unknown as Promise<CountRow | undefined>
      ]);

      // Fetch structured usage metric records for all returned logs
      const logIds = logs.map(l => l.log_id);
      const metricRecordsByLogId = await fetchMetricRecordsByLogId(db, logIds);

      const total = Number(countResult?.count || 0);
      const totalPages = Math.ceil(total / limit);

      res.json({
        logs: logs.map(row => formatLlmLogRow(row, metricRecordsByLogId[row.log_id])),
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1
        }
      });
    } catch (error) {
      console.error('Error in /api/llm-logs:', error);
      res.status(500).json({ error: 'Failed to fetch LLM logs' });
    }
  }

  return { getLlmLogs };
}

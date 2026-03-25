import { Request, Response } from 'express';
import { Knex } from 'knex';
import { validatePagination, validateUUID, validateBoolean } from './validation.js';

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
  return query;
}

function formatLlmLogRow(row: LlmLogRow): Record<string, unknown> {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      // If parsing fails, keep as null
    }
  }
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
  };
}

export function createLlmLogsRoutes(deps: LlmLogsRoutesDeps) {
  const { db } = deps;

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
        agentAlias
      };

      // Build and execute queries
      const baseQuery = db('llm_logs').select(
        'log_id', 'execution_type', 'model_name', 'start_time', 'end_time',
        'duration_ms', 'success', 'input_tokens', 'output_tokens',
        'cache_creation_input_tokens', 'cache_read_input_tokens', 'cost_usd',
        'error_message', 'session_id', 'correlation_id', 'draft_id',
        'repository', 'agent_alias', 'metadata'
      );

      const countQuery = db('llm_logs').count('* as count');

      const [logs, countResult] = await Promise.all([
        applyLlmLogFilters(baseQuery, filters)
          .orderBy('start_time', 'desc')
          .limit(limit)
          .offset(offset) as unknown as Promise<LlmLogRow[]>,
        applyLlmLogFilters(countQuery, filters).first() as unknown as Promise<CountRow | undefined>
      ]);

      const total = Number(countResult?.count || 0);
      const totalPages = Math.ceil(total / limit);

      res.json({
        logs: logs.map(formatLlmLogRow),
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

import { Request, Response } from 'express';
import { Knex } from 'knex';

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

export function createLlmLogsRoutes(deps: LlmLogsRoutesDeps) {
  const { db } = deps;

  async function getLlmLogs(req: Request, res: Response): Promise<void> {
    try {
      // Parse pagination parameters
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
      const offset = (page - 1) * limit;

      // Parse filter parameters
      const executionType = req.query.execution_type as string | undefined;
      const model = req.query.model as string | undefined;
      const success = req.query.success as string | undefined;
      const draftId = req.query.draft_id as string | undefined;
      const agentAlias = req.query.agent_alias as string | undefined;

      // Build base query from the new llm_logs table
      let query = db('llm_logs')
        .select(
          'log_id',
          'execution_type',
          'model_name',
          'start_time',
          'end_time',
          'duration_ms',
          'success',
          'input_tokens',
          'output_tokens',
          'cache_creation_input_tokens',
          'cache_read_input_tokens',
          'cost_usd',
          'error_message',
          'session_id',
          'correlation_id',
          'draft_id',
          'repository',
          'agent_alias',
          'metadata'
        );

      // Apply filters
      if (executionType) {
        query = query.where('execution_type', executionType);
      }
      if (model) {
        query = query.where('model_name', model);
      }
      if (success !== undefined) {
        const successBool = success === 'true' || success === '1';
        query = query.where('success', successBool);
      }
      if (draftId) {
        query = query.where('draft_id', draftId);
      }
      if (agentAlias) {
        query = query.where('agent_alias', agentAlias);
      }

      // Get total count for pagination
      let countQuery = db('llm_logs').count('* as count');
      if (executionType) {
        countQuery = countQuery.where('execution_type', executionType);
      }
      if (model) {
        countQuery = countQuery.where('model_name', model);
      }
      if (success !== undefined) {
        const successBool = success === 'true' || success === '1';
        countQuery = countQuery.where('success', successBool);
      }
      if (draftId) {
        countQuery = countQuery.where('draft_id', draftId);
      }
      if (agentAlias) {
        countQuery = countQuery.where('agent_alias', agentAlias);
      }

      const [logs, countResult] = await Promise.all([
        query
          .orderBy('start_time', 'desc')
          .limit(limit)
          .offset(offset) as unknown as Promise<LlmLogRow[]>,
        countQuery.first() as unknown as Promise<CountRow | undefined>
      ]);

      const total = Number(countResult?.count || 0);
      const totalPages = Math.ceil(total / limit);

      // Format response
      res.json({
        logs: logs.map((row) => {
          // Parse metadata JSON string to object
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
        }),
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

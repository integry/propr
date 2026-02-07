import { Request, Response } from 'express';
import { Knex } from 'knex';

interface LlmLogsRoutesDeps {
  db: Knex;
}

interface LlmExecutionRow {
  execution_id: number;
  task_id: string;
  session_id: string | null;
  conversation_id: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_ms: number | null;
  model_name: string | null;
  success: boolean | number;
  num_turns: number | null;
  cost_usd: number | string | null;
  error_message: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  execution_type: string | null;
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
      const taskId = req.query.task_id as string | undefined;

      // Build base query
      let query = db('llm_executions')
        .select(
          'execution_id',
          'task_id',
          'session_id',
          'conversation_id',
          'start_time',
          'end_time',
          'duration_ms',
          'model_name',
          'success',
          'num_turns',
          'cost_usd',
          'error_message',
          'input_tokens',
          'output_tokens',
          'cache_creation_input_tokens',
          'cache_read_input_tokens',
          'execution_type'
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
      if (taskId) {
        query = query.where('task_id', taskId);
      }

      // Get total count for pagination
      let countQuery = db('llm_executions').count('* as count');
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
      if (taskId) {
        countQuery = countQuery.where('task_id', taskId);
      }

      const [logs, countResult] = await Promise.all([
        query
          .orderBy('start_time', 'desc')
          .limit(limit)
          .offset(offset) as unknown as Promise<LlmExecutionRow[]>,
        countQuery.first() as unknown as Promise<CountRow | undefined>
      ]);

      const total = Number(countResult?.count || 0);
      const totalPages = Math.ceil(total / limit);

      // Format response
      res.json({
        logs: logs.map((row) => ({
          executionId: row.execution_id,
          taskId: row.task_id,
          sessionId: row.session_id,
          conversationId: row.conversation_id,
          startTime: row.start_time,
          endTime: row.end_time,
          durationMs: row.duration_ms,
          modelName: row.model_name,
          success: Boolean(row.success),
          numTurns: row.num_turns,
          costUsd: row.cost_usd ? Number(row.cost_usd) : null,
          errorMessage: row.error_message,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          cacheCreationInputTokens: row.cache_creation_input_tokens,
          cacheReadInputTokens: row.cache_read_input_tokens,
          executionType: row.execution_type || 'implementation'
        })),
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

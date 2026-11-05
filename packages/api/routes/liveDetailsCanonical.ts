import type { RedisClientType } from 'redis';
import type { Knex } from 'knex';
import type { ConversationResult } from './liveDetailsCodexParser.js';
import { parseExecutionDetailsRows, type ExecutionDetailRow } from './liveDetailsExecutionParser.js';
import { isLiveTask } from './liveDetailsTaskState.js';

/** The latest persisted execution of exactly this task and session, projected from its provider records. */
export async function parseExecutionDetailsFromDb(db: Knex, taskId: string, sessionId: string): Promise<ConversationResult | null> {
  const execution = await db('llm_executions')
    .where({ task_id: taskId, session_id: sessionId })
    .orderBy('start_time', 'desc')
    .first('execution_id', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens');
  if (!execution?.execution_id) return null;
  const details = await db('llm_execution_details')
    .where({ execution_id: execution.execution_id })
    .orderBy('sequence_number', 'asc')
    .select('event_type', 'event_timestamp', 'content', 'is_error', 'tool_name', 'tool_input', 'metadata');
  if (!details.length) return null;
  const result = parseExecutionDetailsRows(details as ExecutionDetailRow[]);
  const hasTokens = (execution.input_tokens ?? 0) || (execution.output_tokens ?? 0) || (execution.cache_creation_input_tokens ?? 0) || (execution.cache_read_input_tokens ?? 0);
  return {
    ...result,
    tokenUsage: hasTokens ? {
      input_tokens: execution.input_tokens ?? 0,
      output_tokens: execution.output_tokens ?? 0,
      cache_creation_input_tokens: execution.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: execution.cache_read_input_tokens ?? 0
    } : null
  };
}

/**
 * A finished task's persisted execution details, when its session has any.
 *
 * The task's Redis live log is keyed by task, not execution: whatever last
 * streamed to it (possibly a coarser or different run) is what it holds. Once
 * the task has finished, the provider records persisted for its session are the
 * complete transcript, so they take precedence over that log and over stored
 * output. While the task is live, or when the database cannot be read or holds
 * nothing projectable, this returns null and callers keep their fallbacks.
 */
export async function completedExecutionDetails(
  redisClient: RedisClientType,
  db: Knex,
  taskId: string,
  sessionId: string,
): Promise<ConversationResult | null> {
  if (await isLiveTask(redisClient, db, taskId)) return null;
  try {
    const details = await parseExecutionDetailsFromDb(db, taskId, sessionId);
    return details && details.events.length > 0 ? details : null;
  } catch (error) {
    console.error('[live-details] Persisted execution details unavailable for completed task:', error);
    return null;
  }
}

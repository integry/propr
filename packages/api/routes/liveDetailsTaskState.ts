import type { RedisClientType } from 'redis';
import type { Knex } from 'knex';

const FINISHED_TASK_STATES = new Set(['completed', 'failed', 'cancelled']);

/** Unknown lifecycle state retains live selection; known finished tasks are uncapped. */
export async function isLiveTask(redisClient: RedisClientType, db: Knex, taskId: string): Promise<boolean> {
  try {
    const raw = await redisClient.get(`worker:state:${taskId}`);
    const state = raw ? JSON.parse(raw) as { history?: Array<{ state?: string }> } : null;
    const latest = state?.history?.at(-1)?.state;
    if (latest) return !FINISHED_TASK_STATES.has(latest.toLowerCase());
  } catch { /* Fall back to persisted lifecycle state. */ }
  try {
    const latest = await db('task_history').where({ task_id: taskId }).orderBy('timestamp', 'desc').first('state');
    if (latest?.state) return !FINISHED_TASK_STATES.has(String(latest.state).toLowerCase());
  } catch { /* Some callers only have output storage available. */ }
  return true;
}

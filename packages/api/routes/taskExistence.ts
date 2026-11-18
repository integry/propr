import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { Queue } from 'bullmq';

export interface TaskExistenceSources {
  db: Knex;
  redisClient?: Pick<RedisClientType, 'exists'>;
  taskQueue?: Pick<Queue, 'getJob'>;
}

/**
 * Whether ProPR knows a task by this reference anywhere: its persisted row or
 * history, its live worker state, or a queued job. The task detail routes use
 * it to answer 404 instead of an empty, pending-looking payload. `references`
 * are tried in order, so pass the normalized task id and the raw job id.
 */
export async function taskReferenceExists(sources: TaskExistenceSources, ...references: string[]): Promise<boolean> {
  const ids = [...new Set(references.filter(reference => reference.length > 0))];
  if (ids.length === 0) return false;
  if (await sources.db('tasks').whereIn('task_id', ids).first('task_id')) return true;
  if (await sources.db('task_history').whereIn('task_id', ids).first('task_id')) return true;
  if (sources.redisClient && await sources.redisClient.exists(ids.map(id => `worker:state:${id}`)) > 0) return true;
  if (sources.taskQueue) {
    for (const id of ids) {
      if (await sources.taskQueue.getJob(id)) return true;
    }
  }
  return false;
}

export function sendTaskNotFound(res: { status(code: number): { json(body: unknown): unknown } }): void {
  res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
}

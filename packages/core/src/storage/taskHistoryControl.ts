import type { Knex } from 'knex';
import { createHash } from 'node:crypto';
import type { StorageCandidate } from '@propr/shared';

/** The existing task deletion domain, shared with the task API. No file/config wiping. */
export async function deleteTaskRecords(database: Knex, taskId: string): Promise<void> {
  await database.transaction(async trx => {
    await deleteRows(trx, taskId);
  });
}
async function deleteRows(trx: Knex.Transaction, taskId: string): Promise<void> {
  await trx('llm_execution_details').whereIn('execution_id', function () {
    this.select('execution_id').from('llm_executions').where({ task_id: taskId });
  }).delete();
  await trx('llm_executions').where({ task_id: taskId }).delete();
  await trx('task_history').where({ task_id: taskId }).delete();
  await trx('task_assignees').where({ task_id: taskId }).delete();
  await trx('tasks').where({ task_id: taskId }).delete();
}
async function proof(database: Knex | Knex.Transaction, taskId: string): Promise<string | null> {
  const task = await database('tasks').where({ task_id: taskId }).first();
  const history = await database('task_history').where({ task_id: taskId }).orderBy('history_id', 'desc').first();
  // Failed/unknown tasks remain recovery candidates. Never silently force deletion.
  if (!task || !history || !['completed', 'cancelled'].includes(history.state)) return null;
  const executions = await database('llm_executions').where({ task_id: taskId }).select('execution_id', 'end_time').orderBy('execution_id').limit(1001);
  if (executions.length > 1000) return null;
  if (executions.some(row => !row.end_time)) return null;
  return createHash('sha256').update(JSON.stringify({ task, history, executions })).digest('hex');
}
export function taskHistoryControl(database: Knex) {
  return {
    async inspect(ids: string[]): Promise<Array<{ candidate: StorageCandidate; fingerprint: string | null }>> {
      return Promise.all(ids.map(async id => {
        const fingerprint = await proof(database, id);
        return { candidate: { id, category: 'task_history' as const, estimatedBytes: null, protectedReasons: fingerprint ? [] : ['busy' as const] }, fingerprint };
      }));
    },
    async erase(id: string, expected: string): Promise<boolean> {
      return database.transaction(async trx => {
        if (await proof(trx, id) !== expected) return false;
        await deleteRows(trx, id);
        return true;
      });
    },
  };
}

import type { Knex } from 'knex';

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Automatic-replacement lineage stamps of one `tasks` row, as task detail fields. */
export function attemptLineageFields(task: Record<string, unknown>): {
  attemptNumber: number; replacesTaskId: string | null; replacedByTaskId: string | null;
} {
  return {
    attemptNumber: positiveInteger(task.attempt_number) ?? 1,
    replacesTaskId: typeof task.replaces_task_id === 'string' ? task.replaces_task_id : null,
    replacedByTaskId: typeof task.replaced_by_task_id === 'string' ? task.replaced_by_task_id : null,
  };
}

/** Every attempt of the task's replacement lineage, oldest first; null outside a lineage or on error. */
export async function loadAttemptLineage(db: Knex, taskId: string, task: Record<string, unknown>): Promise<Array<Record<string, unknown>> | null> {
  try {
    const lineage = await fetchAttemptLineage(db, taskId, task);
    return lineage && lineage.length > 1 ? lineage : null;
  } catch (error) {
    console.error('Failed to load task attempt lineage:', error);
    return null;
  }
}

async function fetchAttemptLineage(db: Knex, taskId: string, task: Record<string, unknown>): Promise<Array<Record<string, unknown>> | null> {
  if (!task.replaces_task_id && !task.replaced_by_task_id) return null;
  const root = typeof task.lineage_root_task_id === 'string' ? task.lineage_root_task_id : taskId;
  const rows = await db('tasks as t')
    .where('t.task_id', root)
    .orWhere('t.lineage_root_task_id', root)
    .select('t.task_id', 't.attempt_number', 't.replacement_cause', 't.created_at', db.raw(`(
      SELECT latest_h.state FROM task_history AS latest_h
      WHERE latest_h.task_id = t.task_id
      ORDER BY latest_h.history_id DESC LIMIT 1
    ) AS state`)) as Array<Record<string, unknown>>;
  return rows
    .map(row => ({
      taskId: row.task_id,
      attemptNumber: positiveInteger(row.attempt_number) ?? 1,
      replacementCause: row.replacement_cause ?? null,
      state: row.state ?? null,
      createdAt: row.created_at ?? null,
    }))
    .sort((left, right) => left.attemptNumber - right.attemptNumber);
}

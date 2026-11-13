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

const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;

/** The `tasks` columns `taskLineage` reads. */
export const TASK_LINEAGE_COLUMNS = [
  'task_id', 'attempt_number', 'replaces_task_id', 'replaced_by_task_id', 'lineage_root_task_id',
  'replacement_cause', 'replacement_state',
] as const;

/**
 * The MCP `get_task` lineage of one task: its own replacement stamps and, only when the lineage
 * has more than one attempt, every attempt oldest first. `replacementCause` is why this attempt
 * was created (null for a first attempt); `replacementState` is the replacement decision about
 * this attempt (`pending`, `dispatched`, `skipped`, `exhausted`, or null when none was needed).
 */
export async function taskLineage(db: Knex, taskId: string): Promise<Record<string, unknown> | null> {
  const task = await db('tasks').where({ task_id: taskId }).first(...TASK_LINEAGE_COLUMNS) as Record<string, unknown> | undefined;
  if (!task) return null;
  const { attemptNumber, replacesTaskId, replacedByTaskId } = attemptLineageFields(task);
  const attempts = await loadAttemptLineage(db, taskId, task);
  return {
    attemptNumber,
    rootTaskId: text(task.lineage_root_task_id) ?? taskId,
    replacesTaskId,
    replacedByTaskId,
    replacementCause: text(task.replacement_cause),
    replacementState: text(task.replacement_state),
    ...(attempts ? { attempts } : {}),
  };
}

/**
 * The compact list-row form: the three stamps only for a task that is part of a replacement
 * lineage, nothing for a first and only attempt.
 */
export function attemptLineageSummary(task: Record<string, unknown>): Partial<ReturnType<typeof attemptLineageFields>> {
  const fields = attemptLineageFields(task);
  return fields.attemptNumber > 1 || fields.replacesTaskId || fields.replacedByTaskId ? fields : {};
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

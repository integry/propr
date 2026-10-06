import type { Knex } from 'knex';

/**
 * Provenance of a task a schedule created: `tasks.schedule_id` and the
 * schedule's current name. The name is null once the schedule is deleted; the
 * task still says it was scheduled.
 */
export interface ScheduleProvenance {
  scheduleId: string;
  scheduleName: string | null;
}

/** "Scheduled: <name>", or "Scheduled" when the schedule no longer exists. */
export function scheduledLabel(scheduleName: string | null | undefined): string {
  const name = scheduleName?.trim();
  return name ? `Scheduled: ${name}` : 'Scheduled';
}

function scheduleIdOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** The names of the given schedules, keyed by id. Deleted schedules are absent. */
export async function loadScheduleNames(db: Knex, scheduleIds: Iterable<unknown>): Promise<Map<string, string>> {
  const ids = [...new Set([...scheduleIds].map(scheduleIdOf).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await db('task_schedules').whereIn('id', ids).select('id', 'name') as Array<{ id: string; name: string }>;
  return new Map(rows.map(row => [row.id, row.name]));
}

/** The provenance of one task row, or null when no schedule created it. */
export function scheduleProvenance(scheduleId: unknown, names: ReadonlyMap<string, string>): ScheduleProvenance | null {
  const id = scheduleIdOf(scheduleId);
  return id ? { scheduleId: id, scheduleName: names.get(id) ?? null } : null;
}

/** Loads the provenance of a single task's `schedule_id`. */
export async function loadScheduleProvenance(db: Knex, scheduleId: unknown): Promise<ScheduleProvenance | null> {
  if (!scheduleIdOf(scheduleId)) return null;
  return scheduleProvenance(scheduleId, await loadScheduleNames(db, [scheduleId]));
}

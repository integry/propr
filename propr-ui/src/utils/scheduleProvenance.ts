/** Where schedules are managed. */
export const SCHEDULED_TASKS_SETTINGS_PATH = '/settings?tab=automation#scheduled-tasks';

/** "Scheduled: <name>", or "Scheduled" once the schedule is deleted. */
export function scheduledLabel(scheduleName: string | null | undefined): string {
  const name = scheduleName?.trim();
  return name ? `Scheduled: ${name}` : 'Scheduled';
}

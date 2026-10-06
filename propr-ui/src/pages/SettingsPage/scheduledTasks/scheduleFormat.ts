import type { ScheduleRunStatus, TaskSchedule } from '../../../api/scheduleApi';

export interface CronPreset {
  label: string;
  cron: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { label: 'Nightly 02:00', cron: '0 2 * * *' },
  { label: 'Weekdays 09:00', cron: '0 9 * * 1-5' },
  { label: 'Weekly Monday 03:00', cron: '0 3 * * 1' },
];

/** The browser's IANA time zone, used as the default for new schedules. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** IANA zones the browser knows, offered as suggestions; empty when unsupported. */
export function knownTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

/** A timestamp in the reader's locale and time zone; `—` when absent or invalid. */
export function formatScheduleTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export type ScheduleState = 'enabled' | 'paused' | 'disabled';

export function scheduleState(schedule: Pick<TaskSchedule, 'enabled' | 'pausedReason'>): ScheduleState {
  if (schedule.enabled) return 'enabled';
  return schedule.pausedReason ? 'paused' : 'disabled';
}

export const RUN_STATUS_STYLES: Record<ScheduleRunStatus, string> = {
  dispatching: 'bg-slate-100 text-slate-700',
  dispatched: 'bg-sky-50 text-sky-700',
  succeeded: 'bg-teal-50 text-teal-700',
  failed: 'bg-red-50 text-red-700',
  cancelled: 'bg-slate-100 text-slate-600',
  skipped: 'bg-amber-50 text-amber-800',
};

export const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error || 'Request failed');

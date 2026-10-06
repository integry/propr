import React from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { SCHEDULED_TASKS_SETTINGS_PATH, scheduledLabel } from '../utils/scheduleProvenance';

/**
 * Provenance of a task a schedule created. Links to the schedules in Settings;
 * a long schedule name is cut short, its full label in the tooltip.
 */
export const ScheduledBadge: React.FC<{
  scheduleName?: string | null;
  /** Bounds the badge's width; the name is cut short inside it. */
  className?: string;
}> = ({ scheduleName, className = 'max-w-[16rem]' }) => {
  const label = scheduledLabel(scheduleName);
  return (
    <Link
      to={SCHEDULED_TASKS_SETTINGS_PATH}
      data-testid="scheduled-badge"
      title={scheduleName ? `${label} — open scheduled tasks` : 'Created by a schedule that no longer exists'}
      onClick={event => event.stopPropagation()}
      className={`inline-flex min-w-0 flex-none items-center gap-1 whitespace-nowrap rounded-sm border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[11px] leading-4 text-violet-700 transition-colors hover:border-violet-300 hover:text-violet-900 ${className}`}
    >
      <CalendarClock className="h-3 w-3 flex-none" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Link>
  );
};

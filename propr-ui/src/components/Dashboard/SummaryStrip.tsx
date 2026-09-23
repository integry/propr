/**
 * Summary strip: four counts, each one a door into the list behind it.
 *
 * The counts are neutral by default. Only "Needs attention" changes colour, and
 * only when it is non-zero — if everything is emphasised, nothing is.
 */

import React, { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getDashboardSummary, type DashboardSummaryResponse } from '../../api/dashboardApi';
import {
  type DashboardSectionProps,
  filteredTasksHref,
  useDashboardSection,
} from './sectionState';

interface SummaryCountProps {
  label: string;
  value: number | null;
  href: string;
  title: string;
  emphasised?: boolean;
  testId: string;
}

const SummaryCount: React.FC<SummaryCountProps> = ({ label, value, href, title, emphasised = false, testId }) => (
  <Link
    to={href}
    title={title}
    data-testid={testId}
    data-emphasis={emphasised ? 'true' : 'false'}
    className={`flex min-w-0 flex-col gap-0.5 rounded-lg border px-3 py-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${
      emphasised
        ? 'border-amber-200 bg-amber-50 hover:bg-amber-100'
        : 'border-slate-200 bg-white hover:bg-slate-50'
    }`}
  >
    <span className={`text-xl font-semibold tabular-nums ${emphasised ? 'text-amber-700' : 'text-slate-900'}`}>
      {value === null ? <span className="text-slate-300">—</span> : value}
    </span>
    <span className={`truncate text-[11px] font-medium uppercase tracking-wide ${emphasised ? 'text-amber-700' : 'text-gray-500'}`}>
      {label}
    </span>
  </Link>
);

export const SummaryStrip: React.FC<DashboardSectionProps> = ({ repository, refreshToken, onLoaded }) => {
  const load = useCallback(() => getDashboardSummary(repository), [repository]);
  const { data, error } = useDashboardSection<DashboardSummaryResponse>(load, repository, refreshToken, onLoaded);

  // A failed read leaves the counts unknown. An unknown count is rendered as
  // unknown, never as zero.
  const counts = error && !data ? null : data;
  const windowHours = data?.recentWindowHours ?? 24;

  return (
    <div
      aria-label="Work summary"
      data-testid="summary-strip"
      className="grid grid-cols-2 gap-2 sm:grid-cols-4"
    >
      <SummaryCount
        testId="summary-needs-attention"
        label="Needs attention"
        value={counts?.needsAttention ?? null}
        emphasised={(counts?.needsAttention ?? 0) > 0}
        href={filteredTasksHref('attention', repository)}
        title="Work that is blocked or waiting on a decision"
      />
      <SummaryCount
        testId="summary-running"
        label="Running"
        value={counts?.running ?? null}
        href={filteredTasksHref('active', repository)}
        title="Work running right now"
      />
      <SummaryCount
        testId="summary-queued"
        label="Queued"
        value={counts?.queued ?? null}
        href={filteredTasksHref('waiting', repository)}
        title="Work waiting for an agent"
      />
      <SummaryCount
        testId="summary-completed"
        label={windowHours === 24 ? 'Completed today' : `Completed (${windowHours}h)`}
        value={counts?.completedRecently ?? null}
        href={filteredTasksHref('completed', repository)}
        title={`Work completed in the last ${windowHours} hours`}
      />
    </div>
  );
};

export default SummaryStrip;

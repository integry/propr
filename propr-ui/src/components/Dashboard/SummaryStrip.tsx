/**
 * Summary sub-toolbar: four counts, each one a door into the list behind it.
 *
 * These are four single numbers, so they get one line — not four boxes. The
 * strip is a real piece of chrome rather than loose text between the
 * breadcrumb bar and the feed: a 40px tinted bar with its own bottom rule, so
 * it reads as the console's status/filter bar. Counts stay neutral; only
 * "Needs attention" takes colour, and only when it is non-zero — if everything
 * is emphasised, nothing is.
 *
 * The first count carries the same `px-3` left rail as every section heading
 * below it, so `NEEDS ATTENTION` in the bar sits on the same vertical line as
 * `HAPPENING NOW` in the pane underneath.
 *
 * It wraps below `sm`, where four counts cannot share 320px, so the bar grows
 * to two rows instead of scrolling sideways.
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
    className={`flex min-w-0 items-baseline gap-2 border-r border-slate-200 px-3 py-2.5 last:border-r-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 ${
      emphasised ? 'hover:bg-amber-100/60' : 'hover:bg-slate-100'
    }`}
  >
    <span
      className={`truncate text-[10px] font-bold uppercase tracking-wider ${
        emphasised ? 'text-amber-700' : 'text-slate-500'
      }`}
    >
      {label}
    </span>
    <span
      className={`font-mono text-sm font-semibold tabular-nums ${
        emphasised ? 'text-amber-700' : 'text-slate-900'
      }`}
    >
      {value === null ? <span className="text-slate-300">—</span> : value}
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
      className="flex min-h-10 flex-wrap items-stretch border-b border-slate-200 bg-slate-50/50"
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

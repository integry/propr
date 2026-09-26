/**
 * Historical stats: three numbers and one small chart.
 *
 * Every metric is nullable, and a metric the instance cannot report renders as
 * unavailable rather than as zero — an instance that records no cost has not
 * spent $0, and a period where nothing finished has no success rate.
 *
 * The metric labels are single words. Three of them share a row that is 22rem
 * wide in the right rail and a third of a phone on mobile, and "RECORDED
 * SPEND" does not fit either: it rendered as `RECORDED SP…`, which reads as a
 * broken grid rather than as a heading. The qualification the longer label
 * carried — that only executions which reported a cost contribute — is a
 * footnote about the number, so it lives in the metric's tooltip.
 *
 * The numbers stand alone, without a change against the preceding period: a
 * bare `+65` under a count, explained by a footnote in a smaller grey, was
 * more ink than information in a panel this narrow. The trend is the chart's
 * job.
 */

import React, { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getDashboardStats,
  type DashboardStatsPeriod,
  type DashboardStatsResponse,
} from '../../api/dashboardApi';
import { DailyCompletionsChart } from './DailyCompletionsChart';
import {
  SectionError,
  SectionHeading,
  SectionSkeleton,
} from './sectionPrimitives';
import {
  type DashboardSectionProps,
  useDashboardSection,
} from './sectionState';

const PERIOD_LABELS: Record<DashboardStatsPeriod, string> = { '7d': '7 days', '30d': '30 days' };

/** The one string the panel uses for anything it cannot report. */
const UNAVAILABLE = '—';

const formatCount = (value: number | null): string =>
  value === null || value === undefined ? UNAVAILABLE : value.toLocaleString();

const formatRate = (value: number | null): string =>
  value === null || value === undefined ? UNAVAILABLE : `${value}%`;

const formatSpend = (value: number | null): string =>
  value === null || value === undefined
    ? UNAVAILABLE
    : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const Metric: React.FC<{
  label: string;
  hint?: string;
  value: string;
  testId: string;
}> = ({ label, hint, value, testId }) => (
  <div className="min-w-0">
    {/*
      No `truncate`: a structural label in a data grid must never end in an
      ellipsis, so the copy is short enough to fit the narrowest column the
      grid ever has rather than being cut to fit it.
    */}
    <div className="text-[10px] font-bold uppercase tracking-wide text-gray-500" title={hint}>{label}</div>
    <div
      data-testid={testId}
      className={`text-lg font-semibold tabular-nums ${value === UNAVAILABLE ? 'text-slate-300' : 'text-slate-900'}`}
      title={value === UNAVAILABLE ? 'Not available' : undefined}
    >
      {value}
    </div>
  </div>
);

export const HistoricalStatsPanel: React.FC<DashboardSectionProps> = ({ repository, refreshToken }) => {
  const [period, setPeriod] = useState<DashboardStatsPeriod>('7d');
  const load = useCallback(() => getDashboardStats(repository, period), [repository, period]);
  const { data, error, loading, reload } = useDashboardSection<DashboardStatsResponse>(
    load,
    `${repository}::${period}`,
    refreshToken,
  );

  return (
    <section
      aria-labelledby="historical-stats-heading"
      data-testid="historical-stats-section"
      className="min-w-0 bg-white"
    >
      <SectionHeading id="historical-stats-heading" title="Historical stats">
        <div className="inline-flex rounded-sm bg-slate-200/70 p-0.5" role="group" aria-label="Stats period">
          {(Object.keys(PERIOD_LABELS) as DashboardStatsPeriod[]).map(option => (
            <button
              key={option}
              type="button"
              aria-pressed={period === option}
              onClick={() => setPeriod(option)}
              className={`rounded-sm px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                period === option ? 'bg-white text-slate-800' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {PERIOD_LABELS[option]}
            </button>
          ))}
        </div>
      </SectionHeading>

      {loading && <SectionSkeleton rows={2} />}
      {!loading && error && !data && <SectionError message="Unable to load historical stats" onRetry={reload} />}
      {data && (
        <div className="px-3 py-3">
          <div className="grid grid-cols-3 gap-x-4">
            <Metric
              testId="stat-completed"
              label="Completed"
              hint="Runs that finished successfully in the period"
              value={formatCount(data.completed)}
            />
            <Metric
              testId="stat-success-rate"
              label="Success"
              hint="Share of finished runs that succeeded"
              value={formatRate(data.successRate)}
            />
            <Metric
              testId="stat-spend"
              label="Spend"
              hint="Recorded spend: only executions that reported a cost contribute"
              value={formatSpend(data.recordedSpend)}
            />
          </div>
          <DailyCompletionsChart data={data.dailyCompleted} />
          <div className="mt-2 text-right text-xs">
            <Link to="/analytics" className="font-medium text-gray-500 transition-colors hover:text-gray-800">
              Full analytics
            </Link>
          </div>
        </div>
      )}
    </section>
  );
};

export default HistoricalStatsPanel;

/**
 * Historical stats: three numbers and one small chart.
 *
 * Every metric is nullable, and a metric the instance cannot report renders as
 * unavailable rather than as zero — an instance that records no cost has not
 * spent $0, and a period where nothing finished has no success rate. Cost is
 * labelled "Recorded spend" because only executions that recorded a cost
 * contribute to it.
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
const PERIOD_DAYS: Record<DashboardStatsPeriod, number> = { '7d': 7, '30d': 30 };

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

/** A comparison needs both sides; without them it is simply not shown. */
function comparison(current: number | null, previous: number | null, suffix = ''): string | null {
  if (current === null || previous === null || current === undefined || previous === undefined) return null;
  const delta = Number((current - previous).toFixed(2));
  if (delta === 0) return 'No change';
  const rounded = Math.abs(delta) % 1 === 0 ? Math.abs(delta).toString() : Math.abs(delta).toFixed(2);
  return `${delta > 0 ? '+' : '−'}${rounded}${suffix}`;
}

const Metric: React.FC<{
  label: string;
  value: string;
  change: string | null;
  testId: string;
}> = ({ label, value, change, testId }) => (
  <div className="min-w-0">
    <div className="truncate text-[10px] font-bold uppercase tracking-wide text-gray-500">{label}</div>
    <div
      data-testid={testId}
      className={`text-lg font-semibold tabular-nums ${value === UNAVAILABLE ? 'text-slate-300' : 'text-slate-900'}`}
      title={value === UNAVAILABLE ? 'Not available' : undefined}
    >
      {value}
    </div>
    {change && <div className="truncate text-[11px] text-slate-500">{change}</div>}
  </div>
);

export const HistoricalStatsPanel: React.FC<DashboardSectionProps> = ({ repository, refreshToken, onLoaded }) => {
  const [period, setPeriod] = useState<DashboardStatsPeriod>('7d');
  const load = useCallback(() => getDashboardStats(repository, period), [repository, period]);
  const { data, error, loading, reload } = useDashboardSection<DashboardStatsResponse>(
    load,
    `${repository}::${period}`,
    refreshToken,
    onLoaded,
  );

  const days = PERIOD_DAYS[period];

  return (
    <section
      aria-labelledby="historical-stats-heading"
      data-testid="historical-stats-section"
      className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
    >
      <SectionHeading id="historical-stats-heading" title="Historical stats">
        <div className="inline-flex rounded-md border border-slate-200 p-0.5" role="group" aria-label="Stats period">
          {(Object.keys(PERIOD_LABELS) as DashboardStatsPeriod[]).map(option => (
            <button
              key={option}
              type="button"
              aria-pressed={period === option}
              onClick={() => setPeriod(option)}
              className={`rounded px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                period === option ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:text-slate-700'
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
        <>
          <div className="grid grid-cols-3 gap-3">
            <Metric
              testId="stat-completed"
              label="Completed"
              value={formatCount(data.completed)}
              change={comparison(data.completed, data.previous.completed)}
            />
            <Metric
              testId="stat-success-rate"
              label="Success rate"
              value={formatRate(data.successRate)}
              change={comparison(data.successRate, data.previous.successRate, '%')}
            />
            <Metric
              testId="stat-spend"
              label="Recorded spend"
              value={formatSpend(data.recordedSpend)}
              change={comparison(data.recordedSpend, data.previous.recordedSpend)}
            />
          </div>
          <p className="mt-2 text-[11px] text-slate-400">Compared with the preceding {days} days</p>
          <DailyCompletionsChart data={data.dailyCompleted} />
          <div className="mt-2 text-right text-xs">
            <Link to="/analytics" className="font-medium text-gray-500 transition-colors hover:text-gray-800">
              Full analytics
            </Link>
          </div>
        </>
      )}
    </section>
  );
};

export default HistoricalStatsPanel;

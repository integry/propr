/**
 * Analytics: the fuller reporting view.
 *
 * The repository breakdown and top-model charts live here rather than on the
 * dashboard, which benefits more from space for ongoing work. Nothing here is
 * live: these are aggregates, read once per visit and once per timeframe.
 *
 * One timeframe scopes every section, so the widgets on the page always
 * describe the same period. It lives in `?period=`, omitted for the default,
 * so a view survives reload and back/forward and can be shared.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ANALYTICS_TIMEFRAME_LABELS,
  DEFAULT_ANALYTICS_TIMEFRAME,
  parseAnalyticsTimeframe,
  type AnalyticsTimeframe,
} from '@propr/shared';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import TaskStatsChart from '../components/TaskStatsChart';
import ActivitySparkline from '../components/ActivitySparkline';
import RepositoryBreakdown from '../components/RepositoryBreakdown';
import TopModels from '../components/TopModels';
import AnalyticsTimeframeSelector from '../components/Analytics/AnalyticsTimeframeSelector';
import { getTaskStats, type TaskStatsResponse } from '../api/taskStatsApi';
import { PageLoadingStatus } from '../components/ui/Skeleton';

const formatDate = (dateStr: string): string =>
  new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const AnalyticsPanel: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>{children}</div>
);

/** A settled read, tagged with the timeframe it answers. */
interface TaskStatsResult {
  timeframe: AnalyticsTimeframe;
  stats: TaskStatsResponse | null;
}

const AnalyticsPage: React.FC = () => {
  useDocumentTitle('Analytics');
  const [searchParams, setSearchParams] = useSearchParams();
  const timeframe = parseAnalyticsTimeframe(searchParams.get('period'));
  const [result, setResult] = useState<TaskStatsResult | null>(null);

  const changeTimeframe = useCallback((next: AnalyticsTimeframe) => {
    setSearchParams(current => {
      const params = new URLSearchParams(current);
      if (next === DEFAULT_ANALYTICS_TIMEFRAME) params.delete('period');
      else params.set('period', next);
      return params;
    });
  }, [setSearchParams]);

  useEffect(() => {
    // A response for a timeframe the page has left is dropped, so a slow read
    // can never overwrite a newer one.
    let active = true;
    getTaskStats(timeframe)
      .then(stats => { if (active) setResult({ timeframe, stats }); })
      .catch(error => {
        console.error('Failed to fetch task stats:', error);
        if (active) setResult({ timeframe, stats: null });
      });
    return () => { active = false; };
  }, [timeframe]);

  // Data from another timeframe is never shown under this one's label.
  const settled = result?.timeframe === timeframe ? result : null;
  const taskStats = settled?.stats ?? null;
  const loading = !settled;
  const timeframeLabel = ANALYTICS_TIMEFRAME_LABELS[timeframe];

  const sparklineData = (taskStats?.dailyCounts ?? []).map(item => ({
    date: item.date,
    displayDate: formatDate(item.date),
    count: item.count,
  }));

  return (
    <div className="min-h-full bg-slate-50">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-gray-800 sm:text-2xl">Analytics</h1>
          <p className="mt-1 text-sm text-slate-500" data-testid="analytics-timeframe-summary">
            Aggregate activity across every repository · {timeframeLabel}
          </p>
        </div>
        <AnalyticsTimeframeSelector value={timeframe} onChange={changeTimeframe} />
      </div>
      {/* The widgets load side by side, so the page announces their wait once. */}
      <PageLoadingStatus label="Loading analytics…">
      <div className="grid grid-cols-1 gap-4 px-4 pb-6 sm:px-6 lg:grid-cols-2">
        <AnalyticsPanel>
          <ActivitySparkline data={sparklineData} isLoading={loading} periodLabel={timeframeLabel} />
        </AnalyticsPanel>
        <AnalyticsPanel>
          <TaskStatsChart data={taskStats} mode="distribution" isLoading={loading} />
        </AnalyticsPanel>
        <AnalyticsPanel>
          <RepositoryBreakdown limit={10} timeframe={timeframe} />
        </AnalyticsPanel>
        <AnalyticsPanel>
          <TopModels limit={10} timeframe={timeframe} />
        </AnalyticsPanel>
      </div>
      </PageLoadingStatus>
    </div>
  );
};

export default AnalyticsPage;

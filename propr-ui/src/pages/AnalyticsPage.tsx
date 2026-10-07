/**
 * Analytics: the fuller reporting view.
 *
 * The repository breakdown and model charts live here rather than on the
 * dashboard, which benefits more from space for ongoing work. Nothing here is
 * live: these are aggregates, read once per visit and once per timeframe.
 *
 * One timeframe scopes every section, so the widgets on the page always
 * describe the same period. It lives in `?period=`, omitted for the default,
 * so a view survives reload and back/forward and can be shared.
 *
 * The page is one console on a white canvas, not a grid of cards: a totals
 * band across the top and a delivery band under it, then a split pane —
 * activity and repositories on the left 60% (with the agent efficacy matrix
 * under them); models, task status and token consumption on the right 40% —
 * divided by the same 1px rules the dashboard uses. Each pane is as tall as
 * its content, and the column rule runs to the bottom of the canvas, so there
 * is no card padded out to match its neighbour and no grey floor under the
 * last row.
 */

import React, { useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import {
  ANALYTICS_TIMEFRAME_LABELS,
  DEFAULT_ANALYTICS_TIMEFRAME,
  parseAnalyticsTimeframe,
  type AnalyticsTimeframe,
} from '@propr/shared';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import TaskStatsChart from '../components/TaskStatsChart';
import ActivitySparkline, { ActivityLegend } from '../components/ActivitySparkline';
import RepositoryBreakdown from '../components/RepositoryBreakdown';
import TopModels from '../components/TopModels';
import TokenConsumption from '../components/Analytics/TokenConsumption';
import ReviewQualityByModel from '../components/Analytics/ReviewQualityByModel';
import AnalyticsTimeframeSelector from '../components/Analytics/AnalyticsTimeframeSelector';
import { AnalyticsMetricStrip, UNAVAILABLE, type AnalyticsMetric } from '../components/Analytics/AnalyticsMetricStrip';
import { LockedRepositoryScope } from '../components/Analytics/LockedRepositoryScope';
import { useTimeframeRead } from '../components/Analytics/useTimeframeRead';
import {
  formatCompactNumber,
  formatDuration,
  formatShare,
  formatUsd,
  successRate,
} from '../components/Analytics/analyticsFormat';
import { SectionHeading } from '../components/Dashboard/sectionPrimitives';
import { useHeaderScopeSlot } from '../components/headerScopeSlot';
import {
  getRepositoryStats,
  getReviewScoreSummary,
  getStatsOverview,
  getTaskStats,
  type StatsOverviewResponse,
  type TaskStatsResponse,
} from '../api/taskStatsApi';
import { PageLoadingStatus } from '../components/ui/Skeleton';
import { SystemAlert } from '../components/ui/SystemAlert';

const formatDate = (dateStr: string): string =>
  new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A pane of the console: a heading bar and its content, ruled off from the pane above. */
const Pane: React.FC<{
  id: string; title: string; count?: number | null; first?: boolean; actions?: React.ReactNode; children: React.ReactNode;
}> = ({
  id, title, count, first = false, actions, children,
}) => (
  <section aria-labelledby={id} className={`min-w-0 ${first ? '' : 'border-t border-slate-200'}`}>
    <SectionHeading id={id} title={title} count={count}>{actions}</SectionHeading>
    {children}
  </section>
);

const buildMetrics = (
  tasks: { data: TaskStatsResponse | null; loading: boolean },
  overview: { data: StatsOverviewResponse | null; loading: boolean },
): AnalyticsMetric[] => {
  const summary = tasks.data?.summary;
  const usage = overview.data?.usage;
  const rate = summary ? successRate(summary.completed, summary.failed) : null;
  const fromTasks = (value: string | undefined) => (tasks.loading ? null : value ?? UNAVAILABLE);
  const fromOverview = (value: string | undefined) => (overview.loading ? null : value ?? UNAVAILABLE);
  return [
    { label: 'Total tasks', testId: 'metric-total-tasks', value: fromTasks(summary?.total.toLocaleString()) },
    {
      label: 'Success rate',
      testId: 'metric-success-rate',
      hint: 'Share of finished tasks that succeeded',
      value: fromTasks(rate === null ? undefined : `${rate}%`),
    },
    {
      label: 'Tokens used',
      testId: 'metric-tokens',
      hint: 'Input and output tokens across every execution in the period',
      value: fromOverview(usage ? formatCompactNumber(usage.total_tokens) : undefined),
    },
    {
      label: 'Total spend',
      testId: 'metric-spend',
      hint: 'Recorded spend: only executions that reported a cost contribute',
      value: fromOverview(usage ? formatUsd(usage.total_cost_usd) : undefined),
    },
  ];
};

/**
 * The delivery band: task volume against run volume, and the outcomes an
 * engineering lead reads first — how often work merged on the first attempt,
 * how long it took, and how often a human had to step in.
 */
const buildDeliveryMetrics = (overview: { data: StatsOverviewResponse | null; loading: boolean }): AnalyticsMetric[] => {
  const { runs, delivery, autonomy } = overview.data ?? {};
  const read = (value: string | undefined) => (overview.loading ? null : value ?? UNAVAILABLE);
  const pass = delivery?.first_time_pass;
  const merge = delivery?.time_to_merge_minutes;
  return [
    {
      label: 'Runs per task',
      testId: 'metric-runs-per-task',
      hint: 'Total runs divided by total tasks: the iteration multiplier. A task often takes several runs — implement, review, fix',
      value: read(runs?.per_task == null ? undefined : `${runs.per_task.toFixed(1)}×`),
      detail: runs ? `${runs.total.toLocaleString()} runs · ${runs.tasks.toLocaleString()} tasks` : undefined,
    },
    {
      label: 'First-time pass',
      testId: 'metric-first-time-pass',
      hint: 'Merged pull requests that needed no fix: one implementation run, no follow-up fix and no Ultrafix retry',
      value: read(pass?.rate == null ? undefined : formatShare(pass.rate)),
      detail: pass && pass.n > 0 ? `${pass.passed.toLocaleString()} of ${pass.n.toLocaleString()} merged PRs` : undefined,
    },
    {
      label: 'Time to merge',
      testId: 'metric-time-to-merge',
      hint: 'Mean wall-clock time from task submission to merge',
      value: read(merge?.mean == null ? undefined : formatDuration(merge.mean)),
      detail: merge?.median == null ? undefined : `median ${formatDuration(merge.median)}`,
    },
    {
      label: 'Autonomy',
      testId: 'metric-autonomy',
      hint: 'Finished tasks that completed without failing or asking for an operator',
      value: read(autonomy?.rate == null ? undefined : formatShare(autonomy.rate)),
      detail: autonomy && autonomy.n > 0 ? `${formatShare(autonomy.operator / autonomy.n)} required operator` : undefined,
    },
  ];
};

const AnalyticsPage: React.FC = () => {
  useDocumentTitle('Analytics');
  const [searchParams, setSearchParams] = useSearchParams();
  const timeframe = parseAnalyticsTimeframe(searchParams.get('period'));
  const headerScopeSlot = useHeaderScopeSlot();

  const changeTimeframe = useCallback((next: AnalyticsTimeframe) => {
    setSearchParams(current => {
      const params = new URLSearchParams(current);
      if (next === DEFAULT_ANALYTICS_TIMEFRAME) params.delete('period');
      else params.set('period', next);
      return params;
    });
  }, [setSearchParams]);

  // Each endpoint is read once per timeframe and shared by every pane that
  // shows it, so the totals band and the tables can never disagree.
  const tasks = useTimeframeRead(getTaskStats, timeframe, 'Failed to load task stats');
  const repositories = useTimeframeRead(getRepositoryStats, timeframe, 'Failed to load repository stats');
  const overview = useTimeframeRead(getStatsOverview, timeframe, 'Failed to load model stats');
  const reviewScores = useTimeframeRead(getReviewScoreSummary, timeframe, 'Failed to load review quality');
  const timeframeLabel = ANALYTICS_TIMEFRAME_LABELS[timeframe];

  const sparklineData = (tasks.data?.dailyCounts ?? []).map(item => ({
    date: item.date,
    displayDate: formatDate(item.date),
    count: item.count,
    ...(item.runs === undefined ? {} : { runs: item.runs }),
  }));

  return (
    <div className="flex min-h-full flex-col bg-white">
      {/*
        The toolbar keeps a repository scope on every page that has one, so
        search and the controls beside it never shift between tabs. Analytics
        has no filter to offer, so it shows the scope read-only.
      */}
      {headerScopeSlot && createPortal(<LockedRepositoryScope />, headerScopeSlot)}

      <div className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-slate-900">Analytics</h1>
          {/* Static: the pressed timeframe and the activity heading already say which period. */}
          <p className="text-sm text-slate-500" data-testid="analytics-timeframe-summary">
            Aggregate activity across all repositories
          </p>
        </div>
        <AnalyticsTimeframeSelector value={timeframe} onChange={changeTimeframe} />
      </div>

      {/* The panes load side by side, so the page announces their wait once. */}
      <PageLoadingStatus label="Loading analytics…">
        <AnalyticsMetricStrip metrics={buildMetrics(tasks, overview)} />
        <AnalyticsMetricStrip metrics={buildDeliveryMetrics(overview)} testId="analytics-delivery-strip" label="Delivery" />

        <div className="grid flex-1 grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" data-testid="analytics-split">
          <div className="min-w-0 lg:border-r lg:border-slate-200" data-testid="analytics-primary-pane">
            <Pane
              id="analytics-activity-heading"
              title={`Activity · ${timeframeLabel}`}
              first
              actions={tasks.loading || tasks.error ? undefined : <ActivityLegend data={sparklineData} />}
            >
              <div className="px-3 py-3 sm:px-4">
                {tasks.error
                  ? <SystemAlert>{tasks.error}</SystemAlert>
                  : <ActivitySparkline data={sparklineData} isLoading={tasks.loading} />}
              </div>
            </Pane>
            <Pane
              id="analytics-repositories-heading"
              title="Repository performance"
              count={repositories.data ? repositories.data.repositories.length : null}
            >
              <RepositoryBreakdown
                repositories={repositories.data?.repositories ?? null}
                loading={repositories.loading}
                error={repositories.error}
              />
            </Pane>
            <Pane
              id="analytics-review-quality-heading"
              title="Agent efficacy by model"
              count={reviewScores.data ? reviewScores.data.models.length : null}
            >
              <ReviewQualityByModel summary={reviewScores.data} loading={reviewScores.loading} error={reviewScores.error} />
            </Pane>
          </div>

          <div className="min-w-0 border-t border-slate-200 lg:border-t-0" data-testid="analytics-secondary-pane">
            <Pane id="analytics-models-heading" title="Models" first>
              <TopModels overview={overview.data} loading={overview.loading} error={overview.error} limit={10} />
            </Pane>
            <Pane id="analytics-status-heading" title="Task status">
              <div className="px-3 py-3 sm:px-4">
                {tasks.error
                  ? <SystemAlert>{tasks.error}</SystemAlert>
                  : <TaskStatsChart data={tasks.data} mode="distribution" isLoading={tasks.loading} showHeading={false} />}
              </div>
            </Pane>
            <Pane id="analytics-tokens-heading" title="Token consumption">
              <TokenConsumption overview={overview.data} loading={overview.loading} error={overview.error} />
            </Pane>
          </div>
        </div>
      </PageLoadingStatus>
    </div>
  );
};

export default AnalyticsPage;

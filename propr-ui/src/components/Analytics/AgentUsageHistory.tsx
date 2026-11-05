/**
 * Analytics: provider quota usage over time, from Agent Tank history.
 *
 * Every agent's session, weekly and per-model windows share one chart, so it
 * shows which quota is actually filling up. The provider chips narrow it to
 * some agents; the series chips are the legend as well as the metric filter,
 * each with its latest value, so identity is never color alone. Colors come
 * from the order of every series the answer holds, not of the visible ones,
 * so hiding a line never repaints the others. Past eight series the hues
 * repeat with a dash pattern, so the chart can draw every selected series.
 *
 * History only reaches back about two weeks, so the pane has its own range
 * instead of following the page timeframe. It re-reads when new usage is
 * recorded, so an open page fills in and moves forward on its own. It renders
 * nothing when Agent Tank is off or the viewer may not read usage, like the
 * sidebar's Usage section.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getAgentTankHistory, type AgentTankHistoryResponse } from '../../api/revertApi';
import { useLiveResource } from '../../hooks/useLiveResource';
import { getProviderDisplayName } from '../agentTankMetrics';
import { SectionHeading } from '../Dashboard/sectionPrimitives';
import { SkeletonBlock } from '../ui/Skeleton';
import { SystemAlert } from '../ui/SystemAlert';
import { flattenUsageHistory, readableSeriesLabel, usageMetricLabel, usageSeriesStyle } from '../usageHistory/usageHistoryModel';
import AgentUsageHistoryChart from './AgentUsageHistoryChart';
import AgentUsageHistoryTable from './AgentUsageHistoryTable';
import UsageSeriesSwatch from './UsageSeriesSwatch';
import {
  USAGE_RANGES,
  USAGE_RANGE_LABELS,
  USAGE_RANGE_MS,
  parseUsageHistoryView,
  toPlottedSeries,
  writeUsageHistoryView,
  type UsageHistoryView,
  type UsageRange,
} from './usageHistoryView';

type ReadState =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: AgentTankHistoryResponse; since: number; until: number };

/** A permission refusal means "not for this viewer", not a failure to report. */
function isPermissionError(error: unknown): boolean {
  return error instanceof Error && /instance\.manage_|permission|forbidden/i.test(error.message);
}

type SettledRead = Extract<ReadState, { status: 'hidden' | 'ready' }>;

/**
 * The pane's history, kept current while it is open. A usage push means the
 * backend has just recorded a new sample, and the live resource's reconcile
 * re-reads now and then regardless; each read asks for the range ending now,
 * so the chart and its latest values move forward instead of freezing at mount.
 */
function useUsageHistoryRead(range: UsageRange): ReadState {
  const { data, error, loading } = useLiveResource<SettledRead>({
    read: async signal => {
      const until = Date.now();
      const since = until - USAGE_RANGE_MS[range];
      try {
        const response = await getAgentTankHistory({ since, until, signal });
        return response.enabled ? { status: 'ready', data: response, since, until } : { status: 'hidden' };
      } catch (failure) {
        if (isPermissionError(failure)) return { status: 'hidden' };
        throw failure;
      }
    },
    scopeKey: range,
    interest: { usage: true },
  });
  // A failed refresh keeps the last good answer on screen.
  if (data) return data;
  if (loading) return { status: 'loading' };
  return { status: 'error', message: error || 'Failed to load usage history' };
}

const chipClass = (on: boolean) => `inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors ${
  on ? 'border-slate-300 bg-white text-slate-700' : 'border-slate-200 bg-slate-50 text-slate-400 line-through decoration-slate-300'
}`;

const RangeSelector: React.FC<{ value: UsageRange; onChange: (range: UsageRange) => void }> = ({ value, onChange }) => (
  <div className="inline-flex rounded-sm bg-slate-200/70 p-0.5" role="group" aria-label="Usage history range">
    {USAGE_RANGES.map(option => (
      <button
        key={option}
        type="button"
        aria-pressed={value === option}
        aria-label={`Quota usage, ${USAGE_RANGE_LABELS[option].toLowerCase()}`}
        title={USAGE_RANGE_LABELS[option]}
        onClick={() => onChange(option)}
        className={`rounded-sm px-2 py-0.5 text-xs font-semibold transition-colors ${
          value === option ? 'bg-white text-slate-800' : 'text-slate-500 hover:text-slate-700'
        }`}
      >
        {option}
      </button>
    ))}
  </div>
);

const AgentUsageHistory: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = parseUsageHistoryView(searchParams);
  const read = useUsageHistoryRead(view.range);
  const [showTable, setShowTable] = useState(false);

  const updateView = useCallback((change: (current: UsageHistoryView) => UsageHistoryView) => {
    setSearchParams(current => writeUsageHistoryView(current, change(parseUsageHistoryView(current))), { replace: true });
  }, [setSearchParams]);

  const all = useMemo(() => {
    if (read.status !== 'ready') return [];
    return flattenUsageHistory(read.data.agents).map((series, index) => toPlottedSeries(series, usageSeriesStyle(index)));
  }, [read]);
  const agents = useMemo(() => [...new Set(all.map(series => series.agent))], [all]);
  const offered = all.filter(series => !view.hiddenAgents.has(series.agent));
  const visible = offered.filter(series => !view.hiddenSeries.has(series.id));

  if (read.status === 'hidden') return null;

  const toggleAgent = (agent: string) => updateView(current => {
    const hiddenAgents = new Set(current.hiddenAgents);
    if (hiddenAgents.has(agent)) hiddenAgents.delete(agent);
    else hiddenAgents.add(agent);
    return { ...current, hiddenAgents };
  });
  const toggleSeries = (id: string) => updateView(current => {
    const hiddenSeries = new Set(current.hiddenSeries);
    if (hiddenSeries.has(id)) hiddenSeries.delete(id);
    else hiddenSeries.add(id);
    return { ...current, hiddenSeries };
  });
  const showAll = () => updateView(current => ({ ...current, hiddenAgents: new Set(), hiddenSeries: new Set() }));
  const filtered = view.hiddenAgents.size > 0 || view.hiddenSeries.size > 0;

  let body: React.ReactNode;
  if (read.status === 'loading') {
    body = <SkeletonBlock className="h-[220px] w-full sm:h-[280px]" />;
  } else if (read.status === 'error') {
    body = <SystemAlert>{read.message}</SystemAlert>;
  } else if (all.length === 0) {
    body = (
      <p className="py-10 text-center text-sm text-slate-500">
        No usage history yet. ProPR records a point each time it reads Agent Tank.
      </p>
    );
  } else if (visible.length === 0) {
    body = <p className="py-10 text-center text-sm text-slate-500">Every metric is hidden. Choose one above to plot it.</p>;
  } else {
    body = showTable
      ? <AgentUsageHistoryTable series={visible} />
      : <AgentUsageHistoryChart series={visible} since={read.since} until={read.until} />;
  }

  return (
    <section aria-labelledby="analytics-usage-heading" className="min-w-0 border-b border-slate-200" data-testid="analytics-usage-history">
      <SectionHeading id="analytics-usage-heading" title={`Quota usage · ${USAGE_RANGE_LABELS[view.range]}`}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={showTable}
            onClick={() => setShowTable(value => !value)}
            className="rounded-sm px-2 py-0.5 text-xs font-semibold text-slate-500 hover:text-slate-700"
          >
            {showTable ? 'Chart' : 'Table'}
          </button>
          <RangeSelector value={view.range} onChange={range => updateView(current => ({ ...current, range }))} />
        </div>
      </SectionHeading>
      <div className="space-y-3 px-3 py-3 sm:px-4">
        {all.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2" role="group" aria-label="Filter usage history">
            {/* Each provider chip leads its own metric chips, so a metric needs
                only its short name and the row stays narrow on a phone. */}
            {agents.map(agent => {
              const agentOn = !view.hiddenAgents.has(agent);
              return (
                <div key={agent} className="flex flex-wrap items-center gap-1.5">
                  {agents.length > 1 && (
                    <button
                      type="button"
                      aria-pressed={agentOn}
                      onClick={() => toggleAgent(agent)}
                      className={`${chipClass(agentOn)} font-semibold`}
                    >
                      {getProviderDisplayName(agent)}
                    </button>
                  )}
                  {offered.filter(series => series.agent === agent).map(series => {
                    const on = !view.hiddenSeries.has(series.id);
                    const value = series.latest === null ? '' : ` ${Math.round(series.latest)}%`;
                    return (
                      <button
                        key={series.id}
                        type="button"
                        aria-pressed={on}
                        aria-label={`${series.displayLabel}${value}`}
                        onClick={() => toggleSeries(series.id)}
                        className={chipClass(on)}
                        title={readableSeriesLabel(series)}
                      >
                        <UsageSeriesSwatch color={on ? series.color : '#CBD5E1'} dash={series.dash} />
                        <span className="max-w-[160px] truncate">{usageMetricLabel(series)}</span>
                        {value && <span className="tabular-nums text-slate-500">{value.trim()}</span>}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {filtered && (
              <button type="button" onClick={showAll} className="px-1.5 text-xs font-semibold text-primary-700 hover:underline">
                Show all
              </button>
            )}
          </div>
        )}
        {body}
      </div>
    </section>
  );
};

export default AgentUsageHistory;

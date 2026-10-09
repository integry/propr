/**
 * The totals band across the top of the Analytics console.
 *
 * One full-width row of four figures divided by hairlines, not four cards:
 * the band shares its rules with the panes below it. On a phone it folds to
 * two by two, and the rules fold with it.
 *
 * A figure the page cannot report yet pulses; one it cannot report at all is
 * an em dash, never a zero — and carries no detail line, so an unknown figure
 * is never qualified by a count of nothing.
 */

import React from 'react';
import { SkeletonBlock } from '../ui/Skeleton';

export interface AnalyticsMetric {
  label: string;
  /** Null while loading. */
  value: string | null;
  hint?: string;
  /** A short qualifier under the figure: its denominator or its companion figure. */
  detail?: string;
  testId: string;
}

/** Rules for each cell, by position: right edges inside a row, a bottom edge under the first row on phones. */
const CELL_RULES = [
  'border-r border-b lg:border-b-0',
  'border-b lg:border-b-0 lg:border-r',
  'border-r',
  '',
];

export const UNAVAILABLE = '—';

const MetricList: React.FC<{ metrics: AnalyticsMetric[]; testId: string }> = ({ metrics, testId }) => (
  <dl className="grid flex-none grid-cols-2 border-b border-slate-200 lg:grid-cols-4" data-testid={testId}>
    {metrics.map((metric, index) => (
      <div key={metric.testId} className={`min-w-0 border-slate-200 px-4 py-3 sm:px-6 ${CELL_RULES[index] ?? ''}`}>
        <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500" title={metric.hint}>
          {metric.label}
        </dt>
        <dd
          data-testid={metric.testId}
          className={`mt-1 text-2xl font-semibold tabular-nums ${metric.value === UNAVAILABLE ? 'text-slate-300' : 'text-slate-900'}`}
        >
          {metric.value === null ? <SkeletonBlock pulse className="h-8 w-20" /> : metric.value}
        </dd>
        {metric.detail && metric.value !== null && metric.value !== UNAVAILABLE && (
          <dd className="mt-0.5 truncate text-xs text-slate-500" data-testid={`${metric.testId}-detail`}>{metric.detail}</dd>
        )}
      </div>
    ))}
  </dl>
);

/**
 * A named strip is a group around its list: ARIA does not allow a name on a
 * bare `<dl>`, which has no role to carry one.
 */
export const AnalyticsMetricStrip: React.FC<{ metrics: AnalyticsMetric[]; testId?: string; label?: string }> = ({
  metrics, testId = 'analytics-metric-strip', label,
}) => {
  const list = <MetricList metrics={metrics} testId={testId} />;
  return label ? <div role="group" aria-label={label} className="flex-none">{list}</div> : list;
};

export default AnalyticsMetricStrip;

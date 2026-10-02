/**
 * Where the period's tokens went: prompt against completion, and what a
 * million of them cost.
 *
 * Presentational, like the models table: the page reads the overview once per
 * timeframe and hands it in, so these figures and the totals band agree. The
 * split is the same segmented bar the task status pane uses, in neutral
 * slate: it is history, not work that needs attention. The heading belongs to
 * the pane that holds it.
 *
 * A server that predates the split reports only the total, so the split reads
 * as unknown rather than as an invented 0 / 100.
 */

import React from 'react';
import type { StatsOverviewResponse } from '../../api/taskStatsApi';
import { SkeletonBlock, SkeletonRegion } from '../ui/Skeleton';
import { SystemAlert } from '../ui/SystemAlert';
import { formatCompactNumber, formatUsd } from './analyticsFormat';

interface TokenConsumptionProps {
  overview: StatsOverviewResponse | null;
  loading: boolean;
  error?: string | null;
}

const INPUT_FILL = '#64748B';
const OUTPUT_FILL = '#CBD5E1';
const UNKNOWN = '—';

const ROW = 'flex items-center justify-between gap-3 px-3 py-2 text-sm sm:px-4';

const percent = (part: number, total: number): string =>
  `${(Math.round((part / total) * 1000) / 10).toLocaleString('en-US')}%`;

const TokenConsumption: React.FC<TokenConsumptionProps> = ({ overview, loading, error }) => {
  if (loading) {
    return (
      <SkeletonRegion label="Loading token consumption…">
        <div className="px-3 pb-2 pt-3 sm:px-4"><SkeletonBlock className="h-2 w-full" /></div>
        {[...Array(3)].map((_, i) => (
          <div key={i} className={`${ROW} border-b border-slate-100 last:border-b-0`}>
            <SkeletonBlock className="h-4 w-36" />
            <SkeletonBlock className="h-4 w-16" />
          </div>
        ))}
      </SkeletonRegion>
    );
  }

  if (error) {
    return <div className="p-3 sm:px-4"><SystemAlert>{error}</SystemAlert></div>;
  }

  const usage = overview?.usage;
  if (!usage || usage.total_tokens === 0) {
    return <p className="px-3 py-4 text-sm text-slate-500 sm:px-4">No token usage in this period.</p>;
  }

  const { total_tokens: total, input_tokens: input, output_tokens: output } = usage;
  const hasSplit = input !== undefined && output !== undefined && input + output > 0;
  const perMillion = usage.total_cost_usd / (total / 1_000_000);

  const rows: Array<{ key: string; label: string; fill?: string; value: string; share?: string }> = [
    {
      key: 'input',
      label: 'Input · prompt',
      fill: INPUT_FILL,
      value: hasSplit ? formatCompactNumber(input) : UNKNOWN,
      share: hasSplit ? percent(input, input + output) : undefined,
    },
    {
      key: 'output',
      label: 'Output · completion',
      fill: OUTPUT_FILL,
      value: hasSplit ? formatCompactNumber(output) : UNKNOWN,
      share: hasSplit ? percent(output, input + output) : undefined,
    },
    { key: 'per-million', label: 'Spend per 1M tokens', value: formatUsd(perMillion) },
  ];

  return (
    <div data-testid="token-consumption">
      <div className="px-3 pb-2 pt-3 sm:px-4">
        {hasSplit ? (
          <div
            className="flex h-2 w-full gap-[2px] overflow-hidden rounded-sm bg-slate-100"
            role="img"
            aria-label={`Input ${percent(input, input + output)}, output ${percent(output, input + output)}`}
          >
            <div className="h-full" style={{ flex: `${input} 0 0`, minWidth: '3px', backgroundColor: INPUT_FILL }} />
            <div className="h-full" style={{ flex: `${output} 0 0`, minWidth: '3px', backgroundColor: OUTPUT_FILL }} />
          </div>
        ) : (
          <div className="h-2 w-full rounded-sm bg-slate-100" title="This server does not report the input/output split" />
        )}
      </div>
      <dl>
        {rows.map(row => (
          <div key={row.key} className={`${ROW} border-b border-slate-100 last:border-b-0`} data-testid={`token-row-${row.key}`}>
            <dt className="flex min-w-0 items-center gap-1.5 text-slate-600">
              {row.fill && <span className="h-2 w-2 flex-none rounded-sm" style={{ backgroundColor: row.fill }} aria-hidden="true" />}
              <span className="truncate">{row.label}</span>
            </dt>
            <dd className="flex flex-none items-baseline gap-3 tabular-nums">
              <span className={row.value === UNKNOWN ? 'text-slate-300' : 'text-slate-800'}>{row.value}</span>
              {/* Every row keeps the share column, so the figures line up. */}
              <span className="w-12 text-right text-xs text-slate-500">{row.share ?? ''}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
};

export default TokenConsumption;

/**
 * Review quality by implementer model, from persisted review scores.
 *
 * Presentational, like the models table: the page reads the summary once per
 * timeframe. Every figure carries the number of pull requests behind it, and
 * a figure with nothing behind it reads as unknown, never as zero.
 */

import React from 'react';
import type { ReviewScoreModelSummary, ReviewScoreSummaryResponse } from '../../api/taskStatsApi';
import { formatModelName } from '../../utils/modelDisplay';
import { SkeletonBlock, SkeletonRegion } from '../ui/Skeleton';
import { SystemAlert } from '../ui/SystemAlert';
import { formatUsd } from './analyticsFormat';

interface ReviewQualityByModelProps {
  summary: ReviewScoreSummaryResponse | null;
  loading: boolean;
  error?: string | null;
}

const HEAD = 'whitespace-nowrap px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 sm:px-4';
const CELL = 'px-3 py-2 text-sm tabular-nums sm:px-4';
const UNKNOWN = '—';

const COLUMNS: Array<{ label: string; hint: string }> = [
  { label: 'PRs', hint: 'Pull requests with at least one review score in the period' },
  { label: 'First', hint: 'Mean first review score (median in brackets)' },
  { label: 'Final', hint: 'Mean last score before merge, or latest score if not merged' },
  { label: 'Cycles', hint: 'Mean Ultrafix cycles until a clean review met the goal' },
  { label: 'Merged', hint: 'Merged pull requests among those merged or closed' },
  { label: 'Cost / merged', hint: 'Recorded cost of implementation and follow-up tasks per merged pull request' },
];

/** A value with its denominator underneath, so a mean over one PR never reads like one over fifty. */
const Figure: React.FC<{ value: string | null; n: number; testId?: string }> = ({ value, n, testId }) => (
  <td className={`${CELL} text-right`} data-testid={testId}>
    <span className={value === null ? 'text-slate-400' : 'text-slate-800'}>{value ?? UNKNOWN}</span>
    <span className="block text-[10px] text-slate-400">n={n}</span>
  </td>
);

const score = (value: number | null): string | null => (value === null ? null : value.toFixed(1));

const ModelRow: React.FC<{ row: ReviewScoreModelSummary }> = ({ row }) => {
  const label = row.implementer_model ? formatModelName(row.implementer_model) : 'Unknown model';
  const first = score(row.first_score.mean);
  const median = score(row.first_score.median);
  return (
    <tr className="border-b border-slate-100 last:border-b-0" data-testid="review-quality-row">
      <td className={`${CELL} min-w-0`}>
        <span className={`block truncate font-medium ${row.implementer_model ? 'text-slate-800' : 'italic text-slate-500'}`} title={row.implementer_model ?? undefined}>
          {label}
        </span>
      </td>
      <td className={`${CELL} text-right text-slate-800`}>{row.prs_scored.toLocaleString()}</td>
      <Figure value={first === null ? null : `${first}${median === null ? '' : ` (${median})`}`} n={row.first_score.n} />
      <Figure value={score(row.final_score.mean)} n={row.final_score.n} testId="review-quality-final" />
      <Figure value={score(row.cycles_to_goal.mean)} n={row.cycles_to_goal.n} />
      <Figure
        value={row.merge_rate.value === null ? null : `${Math.round(row.merge_rate.value * 100)}%`}
        n={row.merge_rate.n}
      />
      <Figure value={row.cost_per_merged_pr.usd === null ? null : formatUsd(row.cost_per_merged_pr.usd)} n={row.cost_per_merged_pr.n} />
    </tr>
  );
};

const TableHead: React.FC = () => (
  <thead>
    <tr className="border-b border-slate-200">
      <th className={`${HEAD} text-left`}>Implementer</th>
      {COLUMNS.map(column => (
        <th key={column.label} className={`${HEAD} text-right`} title={column.hint}>{column.label}</th>
      ))}
    </tr>
  </thead>
);

const ReviewQualityByModel: React.FC<ReviewQualityByModelProps> = ({ summary, loading, error }) => {
  if (loading) {
    return (
      <SkeletonRegion label="Loading review quality…">
        <div className="space-y-2 px-3 py-3 sm:px-4" aria-hidden="true">
          {[...Array(3)].map((_, i) => <SkeletonBlock key={i} className="h-5 w-full" />)}
        </div>
      </SkeletonRegion>
    );
  }
  if (error) return <div className="p-3 sm:px-4"><SystemAlert>{error}</SystemAlert></div>;
  if (!summary || summary.models.length === 0) {
    return <p className="px-3 py-4 text-sm text-slate-500 sm:px-4">No review scores in this period.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem]" data-testid="review-quality-table">
        <TableHead />
        <tbody>
          {summary.models.map(row => <ModelRow key={row.implementer_model ?? '(unknown)'} row={row} />)}
        </tbody>
      </table>
    </div>
  );
};

export default ReviewQualityByModel;

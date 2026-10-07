/**
 * The agent efficacy matrix: review quality by implementer model, from
 * persisted review scores.
 *
 * Presentational, like the models table: the page reads the summary once per
 * timeframe. Each column is one plain figure — no `n=` under every cell and
 * no bracketed second number — and the column the matrix exists for is the
 * score delta: did the model's follow-up work actually improve the code?
 *
 * The number of pull requests behind each figure is still one hover away, in
 * the cell's tooltip, so a mean over one PR never passes for one over fifty.
 * A figure with nothing behind it reads as unknown, never as zero.
 */

import React from 'react';
import type { ReviewScoreModelSummary, ReviewScoreSummaryResponse } from '../../api/taskStatsApi';
import { formatModelName } from '../../utils/modelDisplay';
import { SkeletonBlock, SkeletonRegion } from '../ui/Skeleton';
import { SystemAlert } from '../ui/SystemAlert';

interface ReviewQualityByModelProps {
  summary: ReviewScoreSummaryResponse | null;
  loading: boolean;
  error?: string | null;
}

/** Headers may wrap onto two lines, so seven columns fit the pane without scrolling sideways. */
const HEAD = 'px-3 py-2 align-bottom text-[10px] font-bold uppercase leading-tight tracking-wider text-slate-500 sm:px-4';
const CELL = 'whitespace-nowrap px-3 py-2 text-sm tabular-nums sm:px-4';
const UNKNOWN = '—';

const COLUMNS: Array<{ label: string; hint: string }> = [
  { label: 'Evaluated PRs', hint: 'Pull requests with at least one review score in the period' },
  { label: 'Initial score', hint: 'Mean first review score, out of 10' },
  { label: 'Final score', hint: 'Mean last score before merge, or latest score if not merged, out of 10' },
  { label: 'Score delta', hint: 'Mean change from first to final score: whether follow-up work improved the code' },
  { label: 'Avg runs to merge', hint: 'Mean agent runs across a merged pull request\'s implementation and follow-up tasks' },
  { label: 'Merge rate', hint: 'Merged pull requests among those merged or closed' },
];

const prs = (n: number): string => `${n.toLocaleString()} PR${n === 1 ? '' : 's'}`;

/** One figure, with the pull requests behind it in the tooltip rather than under it. */
const Figure: React.FC<{ value: string | null; basis: string; className?: string; testId?: string }> = ({
  value, basis, className = 'text-slate-800', testId,
}) => (
  <td className={`${CELL} text-right`} title={value === null ? `No data (${basis})` : basis} data-testid={testId}>
    <span className={value === null ? 'text-slate-400' : className}>{value ?? UNKNOWN}</span>
  </td>
);

const UNTRACKED_LABEL = 'Manual / Untracked';
const UNTRACKED_HINT = 'Scored pull requests with no recorded implementing run: written by hand, or by an agent outside ProPR';

const score = (value: number | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toFixed(1);

/** `+2.6 ▲` in green, `−2.0 ▼` in red, `0.0` in grey. */
const Delta: React.FC<{ value: number | null | undefined; n: number }> = ({ value, n }) => {
  if (value === null || value === undefined) return <Figure value={null} basis={`over ${prs(n)}`} testId="review-quality-delta" />;
  const rounded = Math.round(value * 10) / 10;
  const text = rounded > 0 ? `+${rounded.toFixed(1)} ▲` : rounded < 0 ? `−${Math.abs(rounded).toFixed(1)} ▼` : '0.0';
  const tone = rounded > 0 ? 'font-medium text-emerald-700' : rounded < 0 ? 'font-medium text-red-600' : 'text-slate-500';
  return <Figure value={text} basis={`Mean over ${prs(n)} with a first and final score`} className={tone} testId="review-quality-delta" />;
};

const ModelRow: React.FC<{ row: ReviewScoreModelSummary }> = ({ row }) => {
  // Scored PRs with no recorded implementer were written outside an agent run ProPR tracked.
  const label = row.implementer_model ? formatModelName(row.implementer_model) : UNTRACKED_LABEL;
  const runs = row.runs_to_merge;
  const rate = row.merge_rate.value;
  return (
    <tr className="border-b border-slate-100 last:border-b-0" data-testid="review-quality-row">
      <td className={`${CELL} min-w-0`}>
        <span className={`block truncate font-medium ${row.implementer_model ? 'text-slate-800' : 'italic text-slate-500'}`} title={row.implementer_model ?? UNTRACKED_HINT}>
          {label}
        </span>
      </td>
      <td className={`${CELL} text-right text-slate-800`}>{row.prs_scored.toLocaleString()}</td>
      <Figure value={score(row.first_score.mean)} basis={`Mean over ${prs(row.first_score.n)}`} />
      <Figure value={score(row.final_score.mean)} basis={`Mean over ${prs(row.final_score.n)}`} testId="review-quality-final" />
      {row.implementer_model ? (
        <Delta value={row.score_delta?.mean} n={row.score_delta?.n ?? 0} />
      ) : (
        // No tracked agent made the follow-up changes, so there is no delta to credit to one.
        <Figure value={null} basis="no tracked agent to credit with the change" testId="review-quality-delta" />
      )}
      <Figure value={score(runs?.mean)} basis={`Mean over ${prs(runs?.n ?? 0)} merged with recorded runs`} testId="review-quality-runs" />
      <Figure
        value={rate === null ? null : `${Math.round(rate * 100)}%`}
        basis={`${row.merge_rate.merged.toLocaleString()} merged of ${prs(row.merge_rate.n)} merged or closed`}
      />
    </tr>
  );
};

const TableHead: React.FC = () => (
  <thead>
    <tr className="border-b border-slate-200">
      <th className={`${HEAD} text-left`}>Model</th>
      {COLUMNS.map(column => (
        <th key={column.label} className={`${HEAD} text-right`} title={column.hint}>{column.label}</th>
      ))}
    </tr>
  </thead>
);

const ReviewQualityByModel: React.FC<ReviewQualityByModelProps> = ({ summary, loading, error }) => {
  if (loading) {
    return (
      <SkeletonRegion label="Loading agent efficacy…">
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
      <table className="w-full min-w-[34rem]" data-testid="review-quality-table">
        <TableHead />
        <tbody>
          {summary.models.map(row => <ModelRow key={row.implementer_model ?? '(unknown)'} row={row} />)}
        </tbody>
      </table>
      <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500 sm:px-4" data-testid="review-quality-scope">
        Covers the {prs(summary.prs_scored)} with a review score in this period; unreviewed work is not scored.
      </p>
    </div>
  );
};

export default ReviewQualityByModel;

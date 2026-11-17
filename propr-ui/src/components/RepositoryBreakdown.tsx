/**
 * Repository performance for the Analytics console.
 *
 * Presentational: the page reads the stats once per timeframe and hands them
 * in, so the table, the metric strip and the charts always describe the same
 * window. The heading belongs to the pane that holds the table.
 *
 * Repositories are monospace code chips, the same entity treatment as every
 * other technical identifier in the app, drawn without their owner: the owner
 * is constant across the instance and stays in the chip's tooltip.
 *
 * Each row opens the Tasks list filtered to its repository, and a non-zero
 * failure count opens it filtered to that repository's failures.
 *
 * The counts follow the totals band above: completed and failed are tasks
 * with a run that completed or failed, and success is completed ÷ (completed
 * + failed), the header's success rate for one repository. In progress is
 * only queued and running work; cancelled, skipped and superseded tasks are
 * counted under Other, never as in progress.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import type { RepositoryStats } from '../api/taskStatsApi';
import { CodeChip } from './ui/CodeChip';
import { formatCount } from '../utils/dateFormat';
import { DrillDownCell, DrillDownRow } from './Analytics/DrillDownRow';
import { tasksHref } from './Analytics/drillDownLinks';
import { SkeletonBlock, SkeletonRegion } from './ui/Skeleton';
import { SystemAlert } from './ui/SystemAlert';

interface RepositoryBreakdownProps {
  repositories: RepositoryStats[] | null;
  loading: boolean;
  error?: string | null;
  limit?: number;
}

const HEAD = 'whitespace-nowrap px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 sm:px-4';
const CELL = 'px-3 py-2 text-sm tabular-nums sm:px-4';
/**
 * The repository column takes the width the counts leave (`w-full max-w-0`
 * lets its chip truncate in an auto-layout table); each count column is as
 * wide as its widest figure, so no count is ever clipped.
 */
const NAME = 'w-full max-w-0';
const FIGURE = 'w-px whitespace-nowrap text-right';
/** Count columns only appear once the pane is wide enough to hold them. */
const WIDE = 'hidden sm:table-cell';
const UNKNOWN = '—';

const successTone = (rate: number): string =>
  rate >= 90 ? 'text-slate-900' : rate >= 50 ? 'text-amber-600' : 'text-red-600';

const TableHead: React.FC = () => (
  <thead>
    <tr className="border-b border-slate-200">
      <th className={`${HEAD} ${NAME} text-left`}>Repository</th>
      <th className={`${HEAD} ${FIGURE}`}>Tasks</th>
      <th className={`${HEAD} ${WIDE} ${FIGURE}`}>Completed</th>
      <th className={`${HEAD} ${WIDE} ${FIGURE}`}>Failed</th>
      <th className={`${HEAD} ${WIDE} ${FIGURE}`} title="Queued or running now">In progress</th>
      <th className={`${HEAD} ${WIDE} ${FIGURE}`} title="Neither completed, failed nor in progress: cancelled, skipped or superseded">Other</th>
      <th className={`${HEAD} ${FIGURE}`} title="Share of finished tasks that succeeded, as in the Success rate above">Success</th>
    </tr>
  </thead>
);

const RepositoryBreakdown: React.FC<RepositoryBreakdownProps> = ({ repositories, loading, error, limit }) => {
  if (loading) {
    return (
      <SkeletonRegion label="Loading top repositories…">
        <table className="w-full" aria-hidden="true">
          <TableHead />
          <tbody>
            {[...Array(4)].map((_, i) => (
              <tr key={i} className="border-b border-slate-100 last:border-b-0">
                <td className={`${CELL} ${NAME}`}><SkeletonBlock className="h-5 w-28 max-w-full" /></td>
                <td className={CELL}><SkeletonBlock className="ml-auto h-4 w-8" /></td>
                {[...Array(4)].map((__, j) => (
                  <td key={j} className={`${CELL} ${WIDE}`}><SkeletonBlock className="ml-auto h-4 w-8" /></td>
                ))}
                <td className={CELL}><SkeletonBlock className="ml-auto h-4 w-10" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </SkeletonRegion>
    );
  }

  if (error) {
    return <div className="p-3 sm:px-4"><SystemAlert>{error}</SystemAlert></div>;
  }

  if (!repositories || repositories.length === 0) {
    return (
      <p className="px-3 py-4 text-sm text-slate-500 sm:px-4">
        No repository activity in this period.
      </p>
    );
  }

  const sorted = [...repositories].sort((a, b) => b.total - a.total);
  const displayRepos = limit ? sorted.slice(0, limit) : sorted;

  return (
    <table className="w-full" data-testid="repository-performance-table">
      <TableHead />
      <tbody>
        {displayRepos.map(repo => {
          const name = repo.repository.split('/').pop();
          return (
            <DrillDownRow key={repo.repository} to={tasksHref(repo.repository)}>
              <DrillDownCell to={tasksHref(repo.repository)} label={`Tasks in ${repo.repository}`} className={`${CELL} ${NAME}`}>
                <CodeChip title={repo.repository} className="transition-colors group-hover:border-slate-300 group-hover:bg-white">{name}</CodeChip>
              </DrillDownCell>
              <td className={`${CELL} ${FIGURE} text-slate-800`}>{formatCount(repo.total)}</td>
              <td className={`${CELL} ${WIDE} ${FIGURE} text-slate-600`}>{formatCount(repo.completed)}</td>
              <td className={`${CELL} ${WIDE} ${FIGURE} ${repo.failed > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                {repo.failed > 0 ? (
                  <Link
                    to={tasksHref(repo.repository, 'failed')}
                    title={`Failed tasks in ${repo.repository}`}
                    aria-label={`${formatCount(repo.failed)} failed tasks in ${repo.repository}`}
                    className="underline decoration-red-200 underline-offset-2 hover:decoration-red-600"
                  >
                    {formatCount(repo.failed)}
                  </Link>
                ) : formatCount(repo.failed)}
              </td>
              <td className={`${CELL} ${WIDE} ${FIGURE} text-slate-600`} data-testid="repository-in-progress">{formatCount(repo.inProgress)}</td>
              <td className={`${CELL} ${WIDE} ${FIGURE} text-slate-500`} data-testid="repository-other">
                {repo.other === undefined ? UNKNOWN : formatCount(repo.other)}
              </td>
              {repo.successRate === null ? (
                <td className={`${CELL} ${FIGURE} text-slate-400`} title="No finished tasks in this period" data-testid="repository-success">{UNKNOWN}</td>
              ) : (
                <td className={`${CELL} ${FIGURE} font-medium ${successTone(repo.successRate)}`} data-testid="repository-success">{repo.successRate}%</td>
              )}
            </DrillDownRow>
          );
        })}
      </tbody>
    </table>
  );
};

export default RepositoryBreakdown;

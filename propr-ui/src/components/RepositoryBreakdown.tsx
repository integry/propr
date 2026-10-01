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
 */

import React from 'react';
import type { RepositoryStats } from '../api/taskStatsApi';
import { CodeChip } from './ui/CodeChip';
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
/** Count columns only appear once the pane is wide enough to hold them. */
const WIDE = 'hidden sm:table-cell';

const successTone = (rate: number): string =>
  rate >= 90 ? 'text-slate-900' : rate >= 50 ? 'text-amber-600' : 'text-red-600';

const TableHead: React.FC = () => (
  <thead>
    <tr className="border-b border-slate-200">
      <th className={`${HEAD} text-left`}>Repository</th>
      <th className={`${HEAD} w-20 text-right`}>Tasks</th>
      <th className={`${HEAD} ${WIDE} w-24 text-right`}>Completed</th>
      <th className={`${HEAD} ${WIDE} w-20 text-right`}>Failed</th>
      <th className={`${HEAD} ${WIDE} w-28 text-right`}>In progress</th>
      <th className={`${HEAD} w-24 text-right`}>Success</th>
    </tr>
  </thead>
);

const RepositoryBreakdown: React.FC<RepositoryBreakdownProps> = ({ repositories, loading, error, limit }) => {
  if (loading) {
    return (
      <SkeletonRegion label="Loading top repositories…">
        <table className="w-full table-fixed" aria-hidden="true">
          <TableHead />
          <tbody>
            {[...Array(4)].map((_, i) => (
              <tr key={i} className="border-b border-slate-100 last:border-b-0">
                <td className={CELL}><SkeletonBlock className="h-5 w-28" /></td>
                <td className={CELL}><SkeletonBlock className="ml-auto h-4 w-8" /></td>
                <td className={`${CELL} ${WIDE}`}><SkeletonBlock className="ml-auto h-4 w-8" /></td>
                <td className={`${CELL} ${WIDE}`}><SkeletonBlock className="ml-auto h-4 w-8" /></td>
                <td className={`${CELL} ${WIDE}`}><SkeletonBlock className="ml-auto h-4 w-8" /></td>
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
    <table className="w-full table-fixed" data-testid="repository-performance-table">
      <TableHead />
      <tbody>
        {displayRepos.map(repo => (
          <tr key={repo.repository} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
            <td className={`${CELL} min-w-0`}>
              <CodeChip title={repo.repository}>{repo.repository.split('/').pop()}</CodeChip>
            </td>
            <td className={`${CELL} text-right text-slate-800`}>{repo.total.toLocaleString()}</td>
            <td className={`${CELL} ${WIDE} text-right text-slate-600`}>{repo.completed.toLocaleString()}</td>
            <td className={`${CELL} ${WIDE} text-right ${repo.failed > 0 ? 'text-red-600' : 'text-slate-400'}`}>{repo.failed.toLocaleString()}</td>
            <td className={`${CELL} ${WIDE} text-right text-slate-600`}>{repo.inProgress.toLocaleString()}</td>
            <td className={`${CELL} text-right font-medium ${successTone(repo.successRate)}`}>{repo.successRate}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export default RepositoryBreakdown;

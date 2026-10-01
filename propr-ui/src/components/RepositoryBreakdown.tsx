import React, { useState, useEffect } from 'react';
import type { AnalyticsTimeframe } from '@propr/shared';
import { getRepositoryStats, RepositoryStats } from '../api/taskStatsApi';
import { SkeletonBlock, SkeletonRegion } from './ui/Skeleton';
import { SystemAlert } from './ui/SystemAlert';

interface RepositoryBreakdownProps {
  limit?: number;
  repositoriesOverride?: RepositoryStats[];
  /** Scope to a window; without one the endpoint keeps its historical scope. */
  timeframe?: AnalyticsTimeframe;
}

const RepositoryBreakdown: React.FC<RepositoryBreakdownProps> = ({ limit, repositoriesOverride, timeframe }) => {
  const [repositories, setRepositories] = useState<RepositoryStats[]>([]);
  const [loading, setLoading] = useState(!repositoriesOverride);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (repositoriesOverride) {
      setRepositories(repositoriesOverride);
      setLoading(false);
      setError(null);
      return;
    }

    // A new timeframe drops the previous one's rows, and a response that lands
    // after the timeframe changed is ignored.
    let active = true;
    setRepositories([]);
    const fetchStats = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await getRepositoryStats(timeframe);
        if (active) setRepositories(data.repositories || []);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load repository stats');
      } finally {
        if (active) setLoading(false);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [repositoriesOverride, timeframe]);

  if (loading) {
    return (
      <div>
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Top Repositories</h3>
        <SkeletonRegion label="Loading top repositories…" className="overflow-hidden">
          <table className="w-full table-fixed">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="text-left py-2 px-2 text-xs uppercase tracking-wider text-slate-500 w-[55%]">Name</th>
                <th className="text-right py-2 px-2 text-xs uppercase tracking-wider text-slate-500 w-[20%]">Total</th>
                <th className="text-right py-2 px-2 text-xs uppercase tracking-wider text-slate-500 w-[25%]">Success</th>
              </tr>
            </thead>
            <tbody>
              {[...Array(5)].map((_, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-2 px-2">
                    <SkeletonBlock className="h-4 w-24" />
                  </td>
                  <td className="py-2 px-2 text-right">
                    <SkeletonBlock className="ml-auto h-4 w-8" />
                  </td>
                  <td className="py-2 px-2">
                    <SkeletonBlock className="ml-auto h-3 w-8" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SkeletonRegion>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Top Repositories</h3>
        <SystemAlert>{error}</SystemAlert>
      </div>
    );
  }

  if (repositories.length === 0) {
    return (
      <div>
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Top Repositories</h3>
        <div className="text-slate-500 text-center py-4">No repository activity yet — data appears after your first task runs.</div>
      </div>
    );
  }

  // Apply limit if specified, sort by total tasks descending
  const displayRepos = limit
    ? [...repositories].sort((a, b) => b.total - a.total).slice(0, limit)
    : repositories;

  return (
    <div>
      <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Top Repositories</h3>
      <div className="overflow-hidden">
        <table className="w-full table-fixed">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="text-left py-2 px-2 text-xs uppercase tracking-wider text-slate-500 w-[55%]">Name</th>
              <th className="text-right py-2 px-2 text-xs uppercase tracking-wider text-slate-500 w-[20%]">Total</th>
              <th className="text-right py-2 px-2 text-xs uppercase tracking-wider text-slate-500 w-[25%]">Success</th>
            </tr>
          </thead>
          <tbody>
            {displayRepos.map((repo) => (
              <tr key={repo.repository} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50 transition-colors">
                <td className="py-2 px-2 min-w-0">
                  <span className="text-slate-800 font-medium text-sm truncate block" title={repo.repository}>
                    {repo.repository.split('/').pop()}
                  </span>
                </td>
                <td className="py-2 px-2 text-right">
                  <span className="text-slate-600 text-sm">{repo.total}</span>
                </td>
                <td className="py-2 px-2 text-right">
                  <span className={`text-xs font-medium ${
                    repo.successRate >= 90 ? 'text-slate-900' :
                    repo.successRate >= 50 ? 'text-amber-600' : 'text-red-600'
                  }`}>
                    {repo.successRate}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default RepositoryBreakdown;

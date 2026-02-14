import React, { useState, useEffect } from 'react';
import { getRepositoryStats, RepositoryStats } from '../api/taskStatsApi';

interface RepositoryBreakdownProps {
  limit?: number;
}

const RepositoryBreakdown: React.FC<RepositoryBreakdownProps> = ({ limit }) => {
  const [repositories, setRepositories] = useState<RepositoryStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await getRepositoryStats();
        setRepositories(data.repositories || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load repository stats');
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
        <h3 className="text-lg font-bold text-slate-800 mb-4">Top Repositories</h3>
        <div className="overflow-x-auto animate-pulse">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="text-left py-2 px-2 text-xs uppercase tracking-wider text-slate-500">Repository</th>
                <th className="text-right py-2 px-2 text-xs uppercase tracking-wider text-slate-500">Total</th>
                <th className="text-right py-2 px-2 text-xs uppercase tracking-wider text-slate-500">Success</th>
              </tr>
            </thead>
            <tbody>
              {[...Array(5)].map((_, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-2 px-2">
                    <div className="h-4 w-24 bg-gray-200 rounded" />
                  </td>
                  <td className="py-2 px-2 text-right">
                    <div className="h-4 w-8 bg-gray-200 rounded ml-auto" />
                  </td>
                  <td className="py-2 px-2">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-12 h-1.5 bg-gray-200 rounded-full" />
                      <div className="h-3 w-8 bg-gray-200 rounded" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-card">
        <h3 className="section-header">Repository Breakdown</h3>
        <div className="text-red-500 text-center py-4">{error}</div>
      </div>
    );
  }

  if (repositories.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
        <h3 className="text-lg font-bold text-slate-800 mb-4">Top Repositories</h3>
        <div className="text-slate-500 text-center py-4">No repository data available yet.</div>
      </div>
    );
  }

  // Apply limit if specified, sort by total tasks descending
  const displayRepos = limit
    ? [...repositories].sort((a, b) => b.total - a.total).slice(0, limit)
    : repositories;

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
      <h3 className="text-lg font-bold text-slate-800 mb-4">
        {limit ? 'Top Repositories' : 'Repository Breakdown'}
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="text-left py-2 px-2 text-xs uppercase tracking-wider text-slate-500">Repository</th>
              <th className="text-right py-2 px-2 text-xs uppercase tracking-wider text-slate-500">Total</th>
              <th className="text-right py-2 px-2 text-xs uppercase tracking-wider text-slate-500">Success</th>
            </tr>
          </thead>
          <tbody>
            {displayRepos.map((repo) => (
              <tr key={repo.repository} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                <td className="py-2 px-2">
                  <span className="text-slate-800 font-medium text-sm truncate block max-w-[150px]" title={repo.repository}>
                    {repo.repository.split('/').pop()}
                  </span>
                </td>
                <td className="py-2 px-2 text-right">
                  <span className="text-slate-600 text-sm">{repo.total}</span>
                </td>
                <td className="py-2 px-2 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-12 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          repo.successRate >= 80 ? 'bg-emerald-500' :
                          repo.successRate >= 50 ? 'bg-amber-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${repo.successRate}%` }}
                      />
                    </div>
                    <span className={`text-xs font-medium ${
                      repo.successRate >= 80 ? 'text-emerald-600' :
                      repo.successRate >= 50 ? 'text-amber-600' : 'text-red-600'
                    }`}>
                      {repo.successRate}%
                    </span>
                  </div>
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

import React, { useState, useEffect } from 'react';
import { getRepositoryStats, RepositoryStats } from '../api/taskStatsApi';

const RepositoryBreakdown: React.FC = () => {
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
      <div className="dashboard-card">
        <h3 className="section-header">Repository Breakdown</h3>
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
          <span className="ml-3 text-slate-500">Loading repository stats...</span>
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
      <div className="dashboard-card">
        <h3 className="section-header">Repository Breakdown</h3>
        <div className="text-slate-500 text-center py-4">No repository data available yet.</div>
      </div>
    );
  }

  return (
    <div className="dashboard-card">
      <h3 className="section-header">Repository Breakdown</h3>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="text-left py-3 px-4 stat-label">Repository</th>
              <th className="text-right py-3 px-4 stat-label">Total</th>
              <th className="text-right py-3 px-4 stat-label">Completed</th>
              <th className="text-right py-3 px-4 stat-label">Failed</th>
              <th className="text-right py-3 px-4 stat-label">In Progress</th>
              <th className="text-right py-3 px-4 stat-label">Success Rate</th>
            </tr>
          </thead>
          <tbody>
            {repositories.map((repo) => (
              <tr key={repo.repository} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                <td className="py-3 px-4">
                  <span className="text-slate-800 font-medium">{repo.repository}</span>
                </td>
                <td className="py-3 px-4 text-right">
                  <span className="text-slate-600">{repo.total}</span>
                </td>
                <td className="py-3 px-4 text-right">
                  <span className="text-emerald-600 font-medium">{repo.completed}</span>
                </td>
                <td className="py-3 px-4 text-right">
                  <span className="text-red-600 font-medium">{repo.failed}</span>
                </td>
                <td className="py-3 px-4 text-right">
                  <span className="text-amber-600 font-medium">{repo.inProgress}</span>
                </td>
                <td className="py-3 px-4 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-16 h-2 bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          repo.successRate >= 80 ? 'bg-emerald-500' :
                          repo.successRate >= 50 ? 'bg-amber-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${repo.successRate}%` }}
                      />
                    </div>
                    <span className={`text-sm font-medium ${
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

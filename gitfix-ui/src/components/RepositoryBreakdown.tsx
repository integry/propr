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
      <div className="bg-gray-800/50 rounded-lg p-6">
        <h3 className="text-xl font-semibold text-white mb-4">Repository Breakdown</h3>
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
          <span className="ml-3 text-gray-400">Loading repository stats...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800/50 rounded-lg p-6">
        <h3 className="text-xl font-semibold text-white mb-4">Repository Breakdown</h3>
        <div className="text-red-400 text-center py-4">{error}</div>
      </div>
    );
  }

  if (repositories.length === 0) {
    return (
      <div className="bg-gray-800/50 rounded-lg p-6">
        <h3 className="text-xl font-semibold text-white mb-4">Repository Breakdown</h3>
        <div className="text-gray-400 text-center py-4">No repository data available yet.</div>
      </div>
    );
  }

  return (
    <div className="bg-gray-800/50 rounded-lg p-6">
      <h3 className="text-xl font-semibold text-white mb-4">Repository Breakdown</h3>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Repository</th>
              <th className="text-right py-3 px-4 text-sm font-medium text-gray-400">Total</th>
              <th className="text-right py-3 px-4 text-sm font-medium text-gray-400">Completed</th>
              <th className="text-right py-3 px-4 text-sm font-medium text-gray-400">Failed</th>
              <th className="text-right py-3 px-4 text-sm font-medium text-gray-400">In Progress</th>
              <th className="text-right py-3 px-4 text-sm font-medium text-gray-400">Success Rate</th>
            </tr>
          </thead>
          <tbody>
            {repositories.map((repo) => (
              <tr key={repo.repository} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                <td className="py-3 px-4">
                  <span className="text-white font-medium">{repo.repository}</span>
                </td>
                <td className="py-3 px-4 text-right">
                  <span className="text-gray-300">{repo.total}</span>
                </td>
                <td className="py-3 px-4 text-right">
                  <span className="text-green-400">{repo.completed}</span>
                </td>
                <td className="py-3 px-4 text-right">
                  <span className="text-red-400">{repo.failed}</span>
                </td>
                <td className="py-3 px-4 text-right">
                  <span className="text-yellow-400">{repo.inProgress}</span>
                </td>
                <td className="py-3 px-4 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-16 h-2 bg-gray-600 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          repo.successRate >= 80 ? 'bg-green-500' :
                          repo.successRate >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${repo.successRate}%` }}
                      />
                    </div>
                    <span className={`text-sm font-medium ${
                      repo.successRate >= 80 ? 'text-green-400' :
                      repo.successRate >= 50 ? 'text-yellow-400' : 'text-red-400'
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

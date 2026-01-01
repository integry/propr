import React, { useState, useEffect } from 'react';
import { getRepositoryStats, RepositoryStatsResponse } from '../api/gitfixApi';

const RepositoryReport: React.FC = () => {
  const [stats, setStats] = useState<RepositoryStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await getRepositoryStats();
        setStats(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load repository statistics');
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
          <span className="ml-3 text-gray-400">Loading...</span>
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

  if (!stats || stats.repositories.length === 0) {
    return (
      <div className="bg-gray-800/50 rounded-lg p-6">
        <h3 className="text-xl font-semibold text-white mb-4">Repository Breakdown</h3>
        <div className="text-gray-400 text-center py-4">No repository data available yet.</div>
      </div>
    );
  }

  const getSuccessRateColor = (rate: number) => {
    if (rate >= 80) return 'text-green-400';
    if (rate >= 50) return 'text-yellow-400';
    return 'text-red-400';
  };

  const getProgressBarColor = (rate: number) => {
    if (rate >= 80) return 'bg-green-500';
    if (rate >= 50) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  return (
    <div className="bg-gray-800/50 rounded-lg p-6">
      <h3 className="text-xl font-semibold text-white mb-4">Repository Breakdown</h3>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-left text-gray-400 text-sm border-b border-gray-700">
              <th className="pb-3 pr-4">Repository</th>
              <th className="pb-3 px-4 text-center">Total</th>
              <th className="pb-3 px-4 text-center">Completed</th>
              <th className="pb-3 px-4 text-center">Failed</th>
              <th className="pb-3 px-4 text-center">In Progress</th>
              <th className="pb-3 pl-4">Success Rate</th>
            </tr>
          </thead>
          <tbody>
            {stats.repositories.map((repo) => (
              <tr key={repo.repository} className="border-b border-gray-700/50 hover:bg-gray-700/30 transition-colors">
                <td className="py-3 pr-4">
                  <a
                    href={`https://github.com/${repo.repository}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-400 hover:text-indigo-300 hover:underline"
                  >
                    {repo.repository}
                  </a>
                </td>
                <td className="py-3 px-4 text-center text-white font-medium">{repo.total}</td>
                <td className="py-3 px-4 text-center text-green-400">{repo.completed}</td>
                <td className="py-3 px-4 text-center text-red-400">{repo.failed}</td>
                <td className="py-3 px-4 text-center text-yellow-400">{repo.inProgress}</td>
                <td className="py-3 pl-4">
                  <div className="flex items-center gap-2">
                    <div className="w-24 bg-gray-700 rounded-full h-2 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${getProgressBarColor(repo.successRate)}`}
                        style={{ width: `${repo.successRate}%` }}
                      />
                    </div>
                    <span className={`text-sm font-medium ${getSuccessRateColor(repo.successRate)}`}>
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

export default RepositoryReport;

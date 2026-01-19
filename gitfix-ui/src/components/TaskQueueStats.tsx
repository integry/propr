import React, { useState, useEffect } from 'react';
import { getQueueStats } from '../api/gitfixApi';

interface QueueStats {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
}

const TaskQueueStats: React.FC = () => {
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);
        const data = await getQueueStats();
        setStats(data);
        setError(null);
      } catch (err) {
        setError('Failed to fetch queue stats');
        console.error('Error fetching queue stats:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000); // Poll every 5 seconds
    return () => clearInterval(interval);
  }, []);

  if (loading && !stats) {
    return <div className="text-gray-500">Loading Queue Stats...</div>;
  }

  if (error) {
    return <div className="text-red-600">Error: {error}</div>;
  }

  const getStatColor = (type: string, value: number): string => {
    if (type === 'failed' && value > 0) return '#ef4444'; // red for failure states
    if (type === 'active' && value > 0) return '#10B981'; // emerald for success/active
    if (type === 'waiting' && value > 10) return '#f59e0b'; // amber for warning
    if (type === 'completed') return '#6366F1'; // indigo for primary/neutral
    return '#1e293b'; // slate-800 for default
  };

  return (
    <div className="min-w-[300px]">
      <h3 className="section-header mb-6">Task Queue</h3>
      <div className="grid grid-cols-2 gap-4 dashboard-card">
        <div className="bg-slate-50 rounded-lg p-4 text-center border border-slate-200">
          <div className="stat-label mb-1">Active</div>
          <div className="stat-value" style={{ color: getStatColor('active', stats?.active) }}>
            {stats?.active || 0}
          </div>
        </div>
        <div className="bg-slate-50 rounded-lg p-4 text-center border border-slate-200">
          <div className="stat-label mb-1">Waiting</div>
          <div className="stat-value" style={{ color: getStatColor('waiting', stats?.waiting) }}>
            {stats?.waiting || 0}
          </div>
        </div>
        <div className="bg-slate-50 rounded-lg p-4 text-center border border-slate-200">
          <div className="stat-label mb-1">Completed (24h)</div>
          <div className="stat-value" style={{ color: getStatColor('completed', stats?.completed) }}>
            {stats?.completed || 0}
          </div>
        </div>
        <div className="bg-slate-50 rounded-lg p-4 text-center border border-slate-200">
          <div className="stat-label mb-1">Failed</div>
          <div className="stat-value" style={{ color: getStatColor('failed', stats?.failed) }}>
            {stats?.failed || 0}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaskQueueStats;
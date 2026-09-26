/**
 * Analytics: the fuller reporting view.
 *
 * The repository breakdown and top-model charts live here rather than on the
 * dashboard, which benefits more from space for ongoing work. Nothing here is
 * live: these are aggregates, read once per visit.
 */

import React, { useEffect, useState } from 'react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import TaskStatsChart from '../components/TaskStatsChart';
import ActivitySparkline from '../components/ActivitySparkline';
import RepositoryBreakdown from '../components/RepositoryBreakdown';
import TopModels from '../components/TopModels';
import { getTaskStats, type TaskStatsResponse } from '../api/taskStatsApi';

const formatDate = (dateStr: string): string =>
  new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const AnalyticsPanel: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>{children}</div>
);

const AnalyticsPage: React.FC = () => {
  useDocumentTitle('Analytics');
  const [taskStats, setTaskStats] = useState<TaskStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getTaskStats()
      .then(stats => { if (active) setTaskStats(stats); })
      .catch(error => console.error('Failed to fetch task stats:', error))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const sparklineData = (taskStats?.dailyCounts ?? []).map(item => ({
    date: item.date,
    displayDate: formatDate(item.date),
    count: item.count,
  }));

  return (
    <div className="min-h-full bg-slate-50">
      <div className="px-4 py-4 sm:px-6">
        <h1 className="text-lg font-bold text-gray-800 sm:text-2xl">Analytics</h1>
        <p className="mt-1 text-sm text-slate-500">Aggregate activity across every repository.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 px-4 pb-6 sm:px-6 lg:grid-cols-2">
        <AnalyticsPanel>
          <ActivitySparkline data={sparklineData} isLoading={loading && !taskStats} />
        </AnalyticsPanel>
        <AnalyticsPanel>
          <TaskStatsChart data={taskStats} mode="distribution" isLoading={loading && !taskStats} />
        </AnalyticsPanel>
        <AnalyticsPanel>
          <RepositoryBreakdown limit={10} />
        </AnalyticsPanel>
        <AnalyticsPanel>
          <TopModels limit={10} />
        </AnalyticsPanel>
      </div>
    </div>
  );
};

export default AnalyticsPage;

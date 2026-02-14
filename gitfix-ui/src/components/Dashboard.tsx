import React, { useState, useEffect } from 'react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import TaskStatsChart from './TaskStatsChart';
import RepositoryBreakdown from './RepositoryBreakdown';
import TopModels from './TopModels';
import TaskList from './TaskList';
import { getQueueStats } from '../api/gitfixApi';
import { getTaskStats, getStatsOverview, TaskStatsResponse, StatsOverviewResponse } from '../api/taskStatsApi';
import { Loader2 } from 'lucide-react';

interface QueueStats {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
}

// Inline MetricItem component for the metrics strip
interface MetricItemProps {
  label: string;
  value: string | number;
  color?: string;
  isLoading?: boolean;
}

const MetricItem: React.FC<MetricItemProps> = ({ label, value, color = 'text-gray-900', isLoading }) => (
  <div className="flex items-center gap-2">
    <span className="text-xs text-gray-500 uppercase tracking-wide">{label}:</span>
    {isLoading ? (
      <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
    ) : (
      <span className={`text-sm font-semibold ${color}`}>{value}</span>
    )}
  </div>
);

const Dashboard: React.FC = () => {
  useDocumentTitle('Dashboard');

  // Lifted state for KPIs
  const [taskStats, setTaskStats] = useState<TaskStatsResponse | null>(null);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [overviewStats, setOverviewStats] = useState<StatsOverviewResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState<boolean>(true);

  // Fetch task stats, queue stats, and overview stats for KPIs
  useEffect(() => {
    const fetchAllStats = async () => {
      try {
        setStatsLoading(true);
        const [tStats, qStats, oStats] = await Promise.all([
          getTaskStats(),
          getQueueStats(),
          getStatsOverview()
        ]);
        setTaskStats(tStats);
        setQueueStats(qStats as QueueStats);
        setOverviewStats(oStats);
      } catch (err) {
        console.error('Failed to fetch stats:', err);
      } finally {
        setStatsLoading(false);
      }
    };

    fetchAllStats();
    const interval = setInterval(fetchAllStats, 5000);
    return () => clearInterval(interval);
  }, []);

  // Calculate success rate
  const getSuccessRate = (): string => {
    if (!taskStats?.summary) return '0%';
    const { completed, total } = taskStats.summary;
    if (total === 0) return '0%';
    return Math.round((completed / total) * 100) + '%';
  };

  return (
    <div>
      {/* Metrics Strip - Subtle gray background */}
      <div className="bg-gray-50 border-b border-gray-200 px-4 sm:px-8 py-3">
        <div className="flex flex-wrap items-center gap-4 sm:gap-6 justify-start">
          <MetricItem
            label="Active"
            value={queueStats?.active || 0}
            color="text-green-600"
            isLoading={statsLoading && !queueStats}
          />
          <MetricItem
            label="Success Rate"
            value={getSuccessRate()}
            color="text-blue-600"
            isLoading={statsLoading && !taskStats}
          />
          <MetricItem
            label="Total Tasks"
            value={taskStats?.summary?.total || 0}
            isLoading={statsLoading && !taskStats}
          />
          <MetricItem
            label="Failed"
            value={taskStats?.summary?.failed || 0}
            color="text-red-500"
            isLoading={statsLoading && !taskStats}
          />
          <MetricItem
            label="Cost"
            value={`$${(overviewStats?.usage?.total_cost_usd ?? 0).toFixed(2)}`}
            color="text-violet-600"
            isLoading={statsLoading && !overviewStats}
          />
        </div>
      </div>

      {/* Main Content */}
      <div className="p-4 sm:p-8">
        {/* 70/30 Split Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-10 gap-6">
          {/* Left Column (70% - 7/10) - Recent Activity Feed */}
          <div className="lg:col-span-7">
            <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
              <h3 className="text-lg font-bold text-slate-800 mb-4">Recent Activity</h3>
              <TaskList
                limit={10}
                showViewAll={true}
                hideFilters={true}
              />
            </div>
          </div>

          {/* Right Column (30% - 3/10) - Analytics and Charts */}
          <div className="lg:col-span-3 space-y-6">
            {/* Task Stats Distribution */}
            <TaskStatsChart data={taskStats} mode="distribution" />

            {/* Repository Breakdown */}
            <RepositoryBreakdown limit={5} />

            {/* Top Models */}
            <TopModels limit={5} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;

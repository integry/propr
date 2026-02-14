import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import TaskStatsChart from './TaskStatsChart';
import RepositoryBreakdown from './RepositoryBreakdown';
import TopModels from './TopModels';
import TaskList from './TaskList';
import ActivitySparkline from './ActivitySparkline';
import { getQueueStats } from '../api/gitfixApi';
import { getTaskStats, getStatsOverview, TaskStatsResponse, StatsOverviewResponse } from '../api/taskStatsApi';
import { Loader2, ChevronRight } from 'lucide-react';

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
  showSeparator?: boolean;
}

const MetricItem: React.FC<MetricItemProps> = ({ label, value, color = 'text-gray-900', isLoading, showSeparator = true }) => (
  <div className="flex items-center">
    <div className="flex flex-col items-start">
      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</span>
      {isLoading ? (
        <Loader2 className="w-4 h-4 animate-spin text-gray-400 mt-0.5" />
      ) : (
        <span className={`text-sm font-bold ${color}`}>{value}</span>
      )}
    </div>
    {showSeparator && (
      <div className="h-8 w-px bg-gray-300 ml-6 mr-6 hidden sm:block" />
    )}
  </div>
);

// Helper function to calculate success rate
const calculateSuccessRate = (taskStats: TaskStatsResponse | null): string => {
  if (!taskStats?.summary) return '0%';
  const { completed, total } = taskStats.summary;
  if (total === 0) return '0%';
  return Math.round((completed / total) * 100) + '%';
};

// Helper function to format cost
const formatCost = (overviewStats: StatsOverviewResponse | null): string => {
  const cost = overviewStats?.usage?.total_cost_usd ?? 0;
  return `$${cost.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

// Metrics Strip component
interface MetricsStripProps {
  queueStats: QueueStats | null;
  taskStats: TaskStatsResponse | null;
  overviewStats: StatsOverviewResponse | null;
  statsLoading: boolean;
}

const MetricsStrip: React.FC<MetricsStripProps> = ({ queueStats, taskStats, overviewStats, statsLoading }) => (
  <div className="bg-gray-50 border-b border-gray-200 px-4 sm:px-8 py-4">
    <div className="flex flex-wrap items-center gap-4 sm:gap-0 justify-start">
      <MetricItem
        label="Active"
        value={queueStats?.active || 0}
        color="text-green-600"
        isLoading={statsLoading && !queueStats}
      />
      <MetricItem
        label="Success"
        value={calculateSuccessRate(taskStats)}
        color="text-blue-600"
        isLoading={statsLoading && !taskStats}
      />
      <MetricItem
        label="Total"
        value={taskStats?.summary?.total?.toLocaleString() || 0}
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
        value={formatCost(overviewStats)}
        color="text-violet-600"
        isLoading={statsLoading && !overviewStats}
        showSeparator={false}
      />
    </div>
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

  // Format date for sparkline display
  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  // Prepare sparkline data from dailyCounts
  const sparklineData = taskStats?.dailyCounts?.map(item => ({
    date: item.date,
    displayDate: formatDate(item.date),
    count: item.count,
  })) || [];

  return (
    <div>
      {/* Metrics Strip - Subtle gray background */}
      <MetricsStrip
        queueStats={queueStats}
        taskStats={taskStats}
        overviewStats={overviewStats}
        statsLoading={statsLoading}
      />

      {/* Main Content */}
      <div className="p-4 sm:p-8">
        {/* 70/30 Split Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-10 gap-6">
          {/* Left Column (70% - 7/10) - Recent Activity Feed */}
          <div className="lg:col-span-7">
            <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-slate-800">Recent Activity</h3>
                <Link
                  to="/tasks"
                  className="flex items-center gap-1 text-sm font-medium text-teal-600 hover:text-teal-700 transition-colors"
                >
                  View All
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </div>
              <TaskList
                limit={10}
                showViewAll={false}
                hideFilters={true}
              />
            </div>
          </div>

          {/* Right Column (30% - 3/10) - Analytics and Charts */}
          <div className="lg:col-span-3 space-y-6">
            {/* Activity Sparkline - Minimalist trend chart at top */}
            <ActivitySparkline data={sparklineData} />

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

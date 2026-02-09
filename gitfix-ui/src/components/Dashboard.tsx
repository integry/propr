import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import TaskStatsChart from './TaskStatsChart';
import RepositoryBreakdown from './RepositoryBreakdown';
import TopModels from './TopModels';
import TaskList from './TaskList';
import { getQueueStats } from '../api/gitfixApi';
import { getTaskStats, getStatsOverview, TaskStatsResponse, StatsOverviewResponse } from '../api/taskStatsApi';
import { KPICard } from './Dashboard/index';

interface QueueStats {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
}

const Dashboard: React.FC = () => {
  useDocumentTitle('Dashboard');
  const navigate = useNavigate();

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

  // Handler to navigate directly to new plan studio
  const handleNewPlan = () => {
    navigate('/studio/new');
  };

  return (
    <div>
      {/* New Plan CTA */}
      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-8 shadow-md hover:shadow-lg transition-all duration-300 border-t-4 border-t-indigo-500">
        <div className="flex justify-between items-center">
          <div>
            <h3 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
              <span>✨</span> Start New AI Plan
            </h3>
            <p className="text-gray-500 text-sm mt-1">Create an implementation plan for your next feature or task</p>
          </div>
          <button
            onClick={handleNewPlan}
            className="px-6 py-3 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            + New Plan
          </button>
        </div>
      </div>

      {/* KPI Bar */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        <KPICard
          title="Active Tasks"
          value={queueStats?.active || 0}
          color="text-green-600"
          isLoading={statsLoading && !queueStats}
        />
        <KPICard
          title="Success Rate"
          value={getSuccessRate()}
          color="text-blue-600"
          isLoading={statsLoading && !taskStats}
        />
        <KPICard
          title="Total Tasks"
          value={taskStats?.summary?.total || 0}
          isLoading={statsLoading && !taskStats}
        />
        <KPICard
          title="Failed"
          value={taskStats?.summary?.failed || 0}
          color="text-red-500"
          isLoading={statsLoading && !taskStats}
        />
        <KPICard
          title="Total Cost"
          value={`$${(overviewStats?.usage?.total_cost_usd ?? 0).toFixed(2)}`}
          color="text-violet-600"
          isLoading={statsLoading && !overviewStats}
        />
      </div>

      {/* Main Grid - 2 columns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (2/3 width) */}
        <div className="lg:col-span-2 space-y-6">
          {/* Trend Charts */}
          <TaskStatsChart data={taskStats} mode="trends" />

          {/* Recent Tasks */}
          <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
            <h3 className="text-lg font-bold text-slate-800 mb-4">Recent Tasks</h3>
            <TaskList
              limit={5}
              showViewAll={true}
              hideFilters={true}
            />
          </div>
        </div>

        {/* Right Column (1/3 width) */}
        <div className="space-y-6">
          {/* Status Distribution */}
          <TaskStatsChart data={taskStats} mode="distribution" />

          {/* Top Repositories */}
          <RepositoryBreakdown limit={5} />

          {/* Top Models */}
          <TopModels limit={5} />
        </div>
      </div>
    </div>
  );
};

export default Dashboard;

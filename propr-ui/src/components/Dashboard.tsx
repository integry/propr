import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSystemReadiness } from '../hooks/useSystemReadiness';
import TaskStatsChart from './TaskStatsChart';
import RepositoryBreakdown from './RepositoryBreakdown';
import TopModels from './TopModels';
import TaskList from './TaskList';
import ActivitySparkline from './ActivitySparkline';
import { OnboardingWidget } from './Dashboard/OnboardingWidget';
import { NoDefaultModelAlert } from './Dashboard/NoDefaultModelAlert';
import AgentTankDetectionBanner from './AgentTankDetectionBanner';
import { getQueueStats } from '../api/proprApi';
import { getTaskStats, getStatsOverview, TaskStatsResponse, StatsOverviewResponse } from '../api/taskStatsApi';
import { Loader2, ChevronRight } from 'lucide-react';
import { useSocket } from '../contexts/useSocket';

interface QueueStats {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
}

// Micro-Card Stat Item for the sidebar stats grid
interface StatItemProps {
  label: string;
  value: string | number;
  color?: string;
  isLoading?: boolean;
}

const StatItem: React.FC<StatItemProps> = ({ label, value, color = 'text-gray-900', isLoading }) => (
  <div className="flex flex-col items-start">
    <span className="text-[10px] font-bold text-gray-500 uppercase">{label}</span>
    {isLoading ? (
      <Loader2 className="w-4 h-4 animate-spin text-gray-400 mt-0.5" />
    ) : (
      <span className={`text-xl font-bold ${color}`}>{value}</span>
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

// Stats Grid component for the right sidebar
interface StatsGridProps {
  queueStats: QueueStats | null;
  taskStats: TaskStatsResponse | null;
  overviewStats: StatsOverviewResponse | null;
  statsLoading: boolean;
}

const StatsGrid: React.FC<StatsGridProps> = ({ queueStats, taskStats, overviewStats, statsLoading }) => (
  <div className="px-6 py-6 border-b border-slate-200">
    {/* 2x2 Grid for Active/Success and Total/Failed with crosshair borders */}
    <div className="grid grid-cols-2">
      <div className="border-r border-b border-slate-200 pr-4 pb-4">
        <StatItem
          label="Active"
          value={queueStats?.active || 0}
          color="text-green-600"
          isLoading={statsLoading && !queueStats}
        />
      </div>
      <div className="border-b border-slate-200 pl-4 pb-4">
        <StatItem
          label="Success"
          value={calculateSuccessRate(taskStats)}
          color="text-blue-600"
          isLoading={statsLoading && !taskStats}
        />
      </div>
      <div className="border-r border-slate-200 pr-4 pt-4">
        <StatItem
          label="Total"
          value={taskStats?.summary?.total?.toLocaleString() || 0}
          isLoading={statsLoading && !taskStats}
        />
      </div>
      <div className="pl-4 pt-4">
        <StatItem
          label="Failed"
          value={taskStats?.summary?.failed || 0}
          color="text-red-500"
          isLoading={statsLoading && !taskStats}
        />
      </div>
    </div>
    {/* Cost - Full width row */}
    <div className="pt-4 mt-4 border-t border-slate-200">
      <StatItem
        label="Total Cost"
        value={formatCost(overviewStats)}
        color="text-violet-600"
        isLoading={statsLoading && !overviewStats}
      />
    </div>
  </div>
);

const Dashboard: React.FC = () => {
  useDocumentTitle('Dashboard');

  // System readiness state for onboarding
  const { hasAgents, hasRepos, hasTasks, isLoading: readinessLoading } = useSystemReadiness();
  const showOnboarding = !readinessLoading && (!hasAgents || !hasRepos || !hasTasks);

  // Lifted state for KPIs
  const [taskStats, setTaskStats] = useState<TaskStatsResponse | null>(null);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [overviewStats, setOverviewStats] = useState<StatsOverviewResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState<boolean>(true);

  // WebSocket for real-time updates
  const { onTaskUpdate, isConnected } = useSocket();

  // Fetch all stats
  const fetchAllStats = useCallback(async (isInitialLoad = false) => {
    try {
      if (isInitialLoad) {
        setStatsLoading(true);
      }
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
  }, []);

  // Initial load
  useEffect(() => {
    fetchAllStats(true);
  }, [fetchAllStats]);

  // Subscribe to WebSocket events for real-time updates
  useEffect(() => {
    if (!isConnected) return;

    // Handle task updates - refresh stats when any task changes state
    const handleTaskUpdate = () => {
      console.log('[Dashboard] Received task update, refreshing stats');
      fetchAllStats(false);
    };

    const unsubscribe = onTaskUpdate(handleTaskUpdate);

    return () => {
      unsubscribe();
    };
  }, [isConnected, onTaskUpdate, fetchAllStats]);

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
    <div className="bg-white min-h-full">
      {/* Error alert when no AI agent is configured */}
      {!readinessLoading && !hasAgents && (
        <div className="px-6 pt-6">
          <NoDefaultModelAlert hasAgents={hasAgents} />
        </div>
      )}

      {/* Onboarding Widget - shown when setup is incomplete */}
      {showOnboarding && (
        <div className="px-6 pt-6">
          <OnboardingWidget hasAgents={hasAgents} hasRepos={hasRepos} hasTasks={hasTasks} />
        </div>
      )}

      {/* Agent Tank Detection Banner - shown when detected but not enabled */}
      <div className="px-6 pt-4">
        <AgentTankDetectionBanner />
      </div>

      {/* Main Content - Studio Split Layout */}
      <div className="flex flex-col lg:flex-row">
        {/* Left Column (70%) - Activity Feed */}
        <div className="flex-1 lg:w-[70%]">
          {/* Header toolbar */}
          <div className="flex items-center justify-between px-6 py-4">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Recent Activity</h3>
            <Link
              to="/tasks"
              className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
            >
              View All
              <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
          {/* Task list content - no card, no border */}
          <div className="px-6 pb-6">
            <TaskList
              limit={10}
              showViewAll={false}
              hideFilters={true}
            />
          </div>
        </div>

        {/* Vertical Divider - Studio Split */}
        <div className="hidden lg:block w-px bg-gray-200" />

        {/* Right Column (30%) - Unified Analytics Rail */}
        <div className="lg:w-[30%] border-t lg:border-t-0 border-gray-200 bg-[#F8FAFC]">
          {/* Stats Grid - Top of Analytics Column */}
          <StatsGrid
            queueStats={queueStats}
            taskStats={taskStats}
            overviewStats={overviewStats}
            statsLoading={statsLoading}
          />

          {/* Activity Sparkline Section */}
          <div className="px-6 py-6 border-b border-slate-200">
            <ActivitySparkline data={sparklineData} isLoading={statsLoading && !taskStats} />
          </div>

          {/* Task Stats Distribution Section */}
          <div className="px-6 py-6 border-b border-slate-200">
            <TaskStatsChart data={taskStats} mode="distribution" isLoading={statsLoading && !taskStats} />
          </div>

          {/* Repository Breakdown Section */}
          <div className="px-6 py-6 border-b border-slate-200">
            <RepositoryBreakdown limit={5} />
          </div>

          {/* Top Models Section - No bottom border (last section) */}
          <div className="px-6 py-6">
            <TopModels limit={5} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;

import React, { useState, useEffect, useCallback } from 'react';
import { getTaskStats, TaskStatsResponse } from '../api/proprApi';
import { VolumeChart, ProcessingTimeChart, StatusSegmentedBar } from './TaskStatsChartParts';
import { buildStatusBreakdown } from './taskStatusBreakdown';
import { useSocket } from '../contexts/useSocket';
import { TaskUpdatePayload } from '@propr/shared';
import { SystemAlert } from './ui/SystemAlert';

const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

interface TaskStatsChartProps {
  data?: TaskStatsResponse | null;
  mode?: 'all' | 'trends' | 'distribution';
  isLoading?: boolean;
}

const TaskStatsChart: React.FC<TaskStatsChartProps> = ({ data: externalData, mode = 'all', isLoading: externalLoading }) => {
  const [internalStats, setInternalStats] = useState<TaskStatsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(!externalData);
  const [error, setError] = useState<string | null>(null);
  const { onTaskUpdate, isConnected } = useSocket();

  // Use external data if provided, otherwise fetch internally
  const stats = externalData !== undefined ? externalData : internalStats;

  // Use external loading state if provided, otherwise use internal
  const isLoading = externalLoading !== undefined ? externalLoading : loading;

  const fetchStats = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true);
      const fetchedData = await getTaskStats();
      setInternalStats(fetchedData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load statistics');
      console.error('Error fetching task stats:', err);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    // Skip fetching if external data is provided
    if (externalData !== undefined) {
      setLoading(false);
      return;
    }

    fetchStats();
  }, [externalData, fetchStats]);

  // Handle task update from WebSocket - refresh stats when task state changes
  const handleTaskUpdate = useCallback(async (payload: TaskUpdatePayload) => {
    // Only refresh stats when task reaches a terminal state (affects aggregate stats)
    const terminalStates = ['completed', 'failed'];
    if (terminalStates.includes(payload.state?.toLowerCase() || '')) {
      console.log('[TaskStatsChart] Received terminal task update via WebSocket');
      await fetchStats(false);
    }
  }, [fetchStats]);

  // Subscribe to WebSocket events for task updates
  useEffect(() => {
    // Skip if external data is provided
    if (externalData !== undefined) return;
    if (!isConnected) return;

    // Listen for task updates
    const unsubscribe = onTaskUpdate(handleTaskUpdate);

    return () => {
      unsubscribe();
    };
  }, [externalData, isConnected, onTaskUpdate, handleTaskUpdate]);

  // Loading skeleton for distribution mode (segmented bar + tabular legend)
  const renderDistributionSkeleton = () => (
    <div>
      <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Task Status</h4>
      <div className="animate-pulse">
        <div className="h-2 w-full rounded-sm bg-gray-200" />
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-sm bg-gray-200" />
                <div className="h-3 w-16 rounded bg-gray-200" />
              </div>
              <div className="h-3 w-8 rounded bg-gray-200" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  if (isLoading && !stats) {
    // For distribution mode, show donut skeleton
    if (mode === 'distribution') {
      return renderDistributionSkeleton();
    }
    // Default loading state for other modes
    return (
      <div>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
          <span className="ml-3 text-slate-500">Loading statistics...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center">
        <SystemAlert>Failed to load statistics: {error}</SystemAlert>
      </div>
    );
  }

  if (!stats) return null;

  // Format data for charts
  const dailyData = stats.dailyCounts.map(item => ({
    date: item.date,
    displayDate: formatDate(item.date),
    count: item.count,
  }));

  // Only states that actually exist are shown; empty states are dropped.
  const statusBreakdown = buildStatusBreakdown(stats.statusDistribution);

  const processingTimeData = stats.avgProcessingTime.map(item => ({
    date: item.date,
    displayDate: formatDate(item.date),
    avgMinutes: item.avgMinutes,
  }));

  const hasData = dailyData.length > 0 || statusBreakdown.length > 0;
  const hasProcessingTimeData = processingTimeData.length > 0 && processingTimeData.some(d => d.avgMinutes > 0);

  // Render trends section - simplified to show only tasks processed
  const renderTrends = () => {
    if (mode === 'trends') {
      return (
        <div>
          <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Tasks Processed (Last 30 Days)</h4>
          {dailyData.length > 0 ? (
            <div className="h-64"><VolumeChart data={dailyData} /></div>
          ) : (
            <div className="h-64 flex items-center justify-center text-slate-500">
              No data available
            </div>
          )}
        </div>
      );
    }

    // In 'all' mode, show both charts side by side
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {dailyData.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Tasks Processed (Last 30 Days)</h4>
            <div className="h-64"><VolumeChart data={dailyData} /></div>
          </div>
        )}
        {hasProcessingTimeData && (
          <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Average Processing Time (Minutes)</h4>
            <div className="h-64"><ProcessingTimeChart data={processingTimeData} showLegend /></div>
          </div>
        )}
      </div>
    );
  };

  // Render distribution section (compact segmented bar)
  const renderDistribution = () => (
    <>
      {statusBreakdown.length > 0 && (
        <div>
          <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Task Status</h4>
          <StatusSegmentedBar data={statusBreakdown} />
        </div>
      )}
    </>
  );

  return (
    <div>
      {!hasData ? (
        <div>
          <div className="text-slate-500 text-center py-8">
            No task data available yet. Statistics will appear once tasks are processed.
          </div>
        </div>
      ) : (
        <>
          {mode === 'all' && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm border-t-4 border-t-indigo-500">
                <div className="text-3xl font-bold text-slate-800">{stats.summary.total}</div>
                <div className="text-slate-500 text-xs uppercase tracking-wider">Total Tasks</div>
              </div>
              <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm border-t-4 border-t-emerald-500">
                <div className="text-3xl font-bold text-emerald-600">{stats.summary.completed}</div>
                <div className="text-slate-500 text-xs uppercase tracking-wider">Completed</div>
              </div>
              <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm border-t-4 border-t-red-500">
                <div className="text-3xl font-bold text-red-600">{stats.summary.failed}</div>
                <div className="text-slate-500 text-xs uppercase tracking-wider">Failed</div>
              </div>
            </div>
          )}
          {mode === 'all' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {renderTrends()}
              {renderDistribution()}
            </div>
          )}
          {mode === 'trends' && renderTrends()}
          {mode === 'distribution' && renderDistribution()}
        </>
      )}
    </div>
  );
};

export default TaskStatsChart;

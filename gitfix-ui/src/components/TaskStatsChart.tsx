import React, { useState, useEffect } from 'react';
import { getTaskStats, TaskStatsResponse } from '../api/gitfixApi';
import { VolumeChart, ProcessingTimeChart, StatusPieChart } from './TaskStatsChartParts';

// Color palette matching the dashboard's indigo/purple theme
const STATUS_COLORS: Record<string, string> = {
  completed: '#10B981', // green
  failed: '#EF4444', // red
  processing: '#F59E0B', // amber
  pending: '#6366F1', // indigo
  claude_execution: '#8B5CF6', // purple
  post_processing: '#EC4899', // pink
  queued: '#6366f1', // indigo
  planning: '#ec4899', // pink
  default: '#94A3B8', // slate
};

const getStatusColor = (status: string): string => {
  return STATUS_COLORS[status] || STATUS_COLORS.default;
};

const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const formatStatus = (status: string): string => {
  const statusMap: Record<string, string> = {
    completed: 'Completed',
    failed: 'Failed',
    processing: 'Processing',
    pending: 'Pending',
    claude_execution: 'AI Execution',
    post_processing: 'Post Processing',
    queued: 'Queued',
    planning: 'Planning',
  };
  return statusMap[status] || status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
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

  // Use external data if provided, otherwise fetch internally
  const stats = externalData !== undefined ? externalData : internalStats;

  // Use external loading state if provided, otherwise use internal
  const isLoading = externalLoading !== undefined ? externalLoading : loading;

  useEffect(() => {
    // Skip fetching if external data is provided
    if (externalData !== undefined) {
      setLoading(false);
      return;
    }

    const fetchStats = async () => {
      try {
        setLoading(true);
        const fetchedData = await getTaskStats();
        setInternalStats(fetchedData);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load statistics');
        console.error('Error fetching task stats:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [externalData]);

  // Loading skeleton for distribution mode (donut chart)
  const renderDistributionSkeleton = () => (
    <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
      <h4 className="text-lg font-bold text-slate-800 mb-4">Task Status Distribution</h4>
      <div className="h-64 flex flex-col items-center justify-center animate-pulse">
        {/* Donut chart skeleton */}
        <div className="relative w-44 h-44">
          <div className="absolute inset-0 rounded-full border-[20px] border-gray-200" />
          <div className="absolute inset-[30px] rounded-full bg-white" />
        </div>
        {/* Legend skeleton */}
        <div className="flex flex-wrap justify-center gap-3 mt-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-gray-200" />
              <div className="h-3 w-14 bg-gray-200 rounded" />
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
      <div className="bg-white border border-slate-200 rounded-lg p-6 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1)]">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
          <span className="ml-3 text-slate-500">Loading statistics...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-6 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1)]">
        <div className="flex items-center justify-center h-64 text-red-500">
          <span>Failed to load statistics: {error}</span>
        </div>
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

  const pieData = stats.statusDistribution.map(item => ({
    name: formatStatus(item.status),
    value: item.count,
    color: getStatusColor(item.status),
  }));

  const processingTimeData = stats.avgProcessingTime.map(item => ({
    date: item.date,
    displayDate: formatDate(item.date),
    avgMinutes: item.avgMinutes,
  }));

  const hasData = dailyData.length > 0 || pieData.length > 0;
  const hasProcessingTimeData = processingTimeData.length > 0 && processingTimeData.some(d => d.avgMinutes > 0);

  // Render trends section - simplified to show only tasks processed
  const renderTrends = () => {
    if (mode === 'trends') {
      return (
        <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
          <h4 className="text-lg font-bold text-slate-800 mb-4">Tasks Processed (Last 30 Days)</h4>
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
            <h4 className="text-lg font-bold text-slate-800 mb-4">Tasks Processed (Last 30 Days)</h4>
            <div className="h-64"><VolumeChart data={dailyData} /></div>
          </div>
        )}
        {hasProcessingTimeData && (
          <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
            <h4 className="text-lg font-bold text-slate-800 mb-4">Average Processing Time (Minutes)</h4>
            <div className="h-64"><ProcessingTimeChart data={processingTimeData} showLegend /></div>
          </div>
        )}
      </div>
    );
  };

  // Render distribution section (donut chart)
  const renderDistribution = () => (
    <>
      {pieData.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
          <h4 className="text-lg font-bold text-slate-800 mb-4">Task Status Distribution</h4>
          <div className="h-64"><StatusPieChart data={pieData} /></div>
        </div>
      )}
    </>
  );

  return (
    <div>
      {!hasData ? (
        <div className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm">
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

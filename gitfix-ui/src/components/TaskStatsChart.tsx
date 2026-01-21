import React, { useState, useEffect } from 'react';
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  Legend,
} from 'recharts';
import { getTaskStats, TaskStatsResponse } from '../api/gitfixApi';

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
}

const TaskStatsChart: React.FC<TaskStatsChartProps> = ({ data: externalData, mode = 'all' }) => {
  const [internalStats, setInternalStats] = useState<TaskStatsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(!externalData);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'volume' | 'time'>('volume');

  // Use external data if provided, otherwise fetch internally
  const stats = externalData !== undefined ? externalData : internalStats;

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
    // Refresh every 5 minutes
    const interval = setInterval(fetchStats, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [externalData]);

  if (loading && !stats) {
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

  if (!stats) {
    return null;
  }

  // Format daily counts for chart
  const dailyData = stats.dailyCounts.map(item => ({
    date: item.date,
    displayDate: formatDate(item.date),
    count: item.count,
  }));

  // Format status distribution for pie chart
  const pieData = stats.statusDistribution.map(item => ({
    name: formatStatus(item.status),
    value: item.count,
    color: getStatusColor(item.status),
  }));

  // Format processing time data
  const processingTimeData = stats.avgProcessingTime.map(item => ({
    date: item.date,
    displayDate: formatDate(item.date),
    avgMinutes: item.avgMinutes,
  }));

  const hasData = dailyData.length > 0 || pieData.length > 0;

  // Render trends section with tabbed interface for trends mode
  const renderTrends = () => {
    const hasProcessingTimeData = processingTimeData.length > 0 && processingTimeData.some(d => d.avgMinutes > 0);

    // In 'trends' mode, use tabbed interface
    if (mode === 'trends') {
      return (
        <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <h4 className="text-lg font-bold text-slate-800">Activity Trends</h4>
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
              <button
                onClick={() => setActiveTab('volume')}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  activeTab === 'volume'
                    ? 'bg-white text-slate-800 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Volume
              </button>
              {hasProcessingTimeData && (
                <button
                  onClick={() => setActiveTab('time')}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    activeTab === 'time'
                      ? 'bg-white text-slate-800 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Time
                </button>
              )}
            </div>
          </div>

          {/* Volume Chart */}
          {activeTab === 'volume' && dailyData.length > 0 && (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={dailyData}>
                  <defs>
                    <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366F1" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#6366F1" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(100, 116, 139, 0.1)" />
                  <XAxis
                    dataKey="displayDate"
                    stroke="#64748B"
                    tick={{ fill: '#64748B', fontSize: 12 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    stroke="#64748B"
                    tick={{ fill: '#64748B', fontSize: 12 }}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#FFFFFF',
                      border: '1px solid #E2E8F0',
                      borderRadius: '8px',
                      color: '#1E293B',
                      boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)',
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="#6366F1"
                    strokeWidth={2}
                    fill="url(#colorCount)"
                    name="Tasks"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Processing Time Chart */}
          {activeTab === 'time' && hasProcessingTimeData && (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={processingTimeData}>
                  <defs>
                    <linearGradient id="colorProcessingTime" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#A855F7" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#A855F7" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(100, 116, 139, 0.1)" />
                  <XAxis
                    dataKey="displayDate"
                    stroke="#64748B"
                    tick={{ fill: '#64748B', fontSize: 12 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    stroke="#64748B"
                    tick={{ fill: '#64748B', fontSize: 12 }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#FFFFFF',
                      border: '1px solid #E2E8F0',
                      borderRadius: '8px',
                      color: '#1E293B',
                      boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)',
                    }}
                    formatter={(value: number) => [`${value.toFixed(1)} min`, 'Avg Time']}
                  />
                  <Area
                    type="monotone"
                    dataKey="avgMinutes"
                    stroke="#A855F7"
                    strokeWidth={2}
                    fill="url(#colorProcessingTime)"
                    dot={{ fill: '#A855F7', r: 3, strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: '#A855F7', stroke: '#FFFFFF', strokeWidth: 2 }}
                    name="Processing Time"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Empty state */}
          {activeTab === 'volume' && dailyData.length === 0 && (
            <div className="h-64 flex items-center justify-center text-slate-500">
              No volume data available
            </div>
          )}
        </div>
      );
    }

    // In 'all' mode, show both charts side by side
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Daily Task Trend - Area Chart */}
        {dailyData.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
            <h4 className="text-lg font-bold text-slate-800 mb-4">Daily Task Volume (Last 30 Days)</h4>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={dailyData}>
                  <defs>
                    <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366F1" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#6366F1" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(100, 116, 139, 0.1)" />
                  <XAxis
                    dataKey="displayDate"
                    stroke="#64748B"
                    tick={{ fill: '#64748B', fontSize: 12 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    stroke="#64748B"
                    tick={{ fill: '#64748B', fontSize: 12 }}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#FFFFFF',
                      border: '1px solid #E2E8F0',
                      borderRadius: '8px',
                      color: '#1E293B',
                      boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)',
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="#6366F1"
                    strokeWidth={2}
                    fill="url(#colorCount)"
                    name="Tasks"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Processing Time Trend - Line Chart */}
        {hasProcessingTimeData && (
          <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
            <h4 className="text-lg font-bold text-slate-800 mb-4">Average Processing Time (Minutes)</h4>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={processingTimeData}>
                  <defs>
                    <linearGradient id="colorProcessingTime" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#A855F7" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#A855F7" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(100, 116, 139, 0.1)" />
                  <XAxis
                    dataKey="displayDate"
                    stroke="#64748B"
                    tick={{ fill: '#64748B', fontSize: 12 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    stroke="#64748B"
                    tick={{ fill: '#64748B', fontSize: 12 }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#FFFFFF',
                      border: '1px solid #E2E8F0',
                      borderRadius: '8px',
                      color: '#1E293B',
                      boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)',
                    }}
                    formatter={(value: number) => [`${value.toFixed(1)} min`, 'Avg Time']}
                  />
                  <Legend
                    wrapperStyle={{ color: '#64748B' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="avgMinutes"
                    stroke="#A855F7"
                    strokeWidth={2}
                    fill="url(#colorProcessingTime)"
                    dot={{ fill: '#A855F7', r: 3, strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: '#A855F7', stroke: '#FFFFFF', strokeWidth: 2 }}
                    name="Processing Time"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
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
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={90}
                  paddingAngle={3}
                  dataKey="value"
                  labelLine={false}
                >
                  {pieData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#FFFFFF',
                    border: '1px solid #E2E8F0',
                    borderRadius: '8px',
                    color: '#1E293B',
                    boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)',
                  }}
                  formatter={(value: number, name: string) => [`${value} tasks`, name]}
                />
                <Legend
                  layout="horizontal"
                  align="center"
                  verticalAlign="bottom"
                  iconType="circle"
                  iconSize={8}
                  formatter={(value: string) => (
                    <span style={{ color: '#64748B', fontSize: '11px' }}>{value}</span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
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
          {/* Summary Cards - only show in 'all' mode */}
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

          {/* Conditional rendering based on mode */}
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

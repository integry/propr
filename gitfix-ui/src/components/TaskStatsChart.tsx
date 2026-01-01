import React, { useState, useEffect } from 'react';
import {
  LineChart,
  Line,
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

const TaskStatsChart: React.FC = () => {
  const [stats, setStats] = useState<TaskStatsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);
        const data = await getTaskStats();
        setStats(data);
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
  }, []);

  if (loading && !stats) {
    return (
      <div className="bg-gray-800/50 rounded-lg p-6">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
          <span className="ml-3 text-gray-400">Loading statistics...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800/50 rounded-lg p-6">
        <div className="flex items-center justify-center h-64 text-red-400">
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

  return (
    <div>
      {!hasData ? (
        <div className="bg-gray-800/50 rounded-lg p-6">
          <div className="text-gray-400 text-center py-8">
            No task data available yet. Statistics will appear once tasks are processed.
          </div>
        </div>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="bg-gray-800/50 rounded-lg p-4">
              <div className="text-3xl font-bold text-white">{stats.summary.total}</div>
              <div className="text-gray-400 text-sm">Total Tasks</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-4">
              <div className="text-3xl font-bold text-green-400">{stats.summary.completed}</div>
              <div className="text-gray-400 text-sm">Completed</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-4">
              <div className="text-3xl font-bold text-red-400">{stats.summary.failed}</div>
              <div className="text-gray-400 text-sm">Failed</div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Daily Task Trend - Area Chart */}
            {dailyData.length > 0 && (
              <div className="bg-gray-800/50 rounded-lg p-4">
                <h4 className="text-lg font-medium text-white mb-4">Daily Task Volume (Last 30 Days)</h4>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={dailyData}>
                      <defs>
                        <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#6366F1" stopOpacity={0.8}/>
                          <stop offset="95%" stopColor="#6366F1" stopOpacity={0.1}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                      <XAxis
                        dataKey="displayDate"
                        stroke="#9CA3AF"
                        tick={{ fill: '#9CA3AF', fontSize: 12 }}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        stroke="#9CA3AF"
                        tick={{ fill: '#9CA3AF', fontSize: 12 }}
                        allowDecimals={false}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#1F2937',
                          border: '1px solid #374151',
                          borderRadius: '8px',
                          color: '#F9FAFB',
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

            {/* Status Distribution - Donut Chart */}
            {pieData.length > 0 && (
              <div className="bg-gray-800/50 rounded-lg p-4">
                <h4 className="text-lg font-medium text-white mb-4">Task Status Distribution</h4>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={pieData}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={90}
                        paddingAngle={2}
                        dataKey="value"
                        label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                        labelLine={{ stroke: '#6B7280' }}
                      >
                        {pieData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#1F2937',
                          border: '1px solid #374151',
                          borderRadius: '8px',
                          color: '#F9FAFB',
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Processing Time Trend - Line Chart */}
            {processingTimeData.length > 0 && processingTimeData.some(d => d.avgMinutes > 0) && (
              <div className="bg-gray-800/50 rounded-lg p-4 lg:col-span-2">
                <h4 className="text-lg font-medium text-white mb-4">Average Processing Time (Minutes)</h4>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={processingTimeData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                      <XAxis
                        dataKey="displayDate"
                        stroke="#9CA3AF"
                        tick={{ fill: '#9CA3AF', fontSize: 12 }}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        stroke="#9CA3AF"
                        tick={{ fill: '#9CA3AF', fontSize: 12 }}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#1F2937',
                          border: '1px solid #374151',
                          borderRadius: '8px',
                          color: '#F9FAFB',
                        }}
                        formatter={(value: number) => [`${value.toFixed(1)} min`, 'Avg Time']}
                      />
                      <Legend
                        wrapperStyle={{ color: '#9CA3AF' }}
                      />
                      <Line
                        type="monotone"
                        dataKey="avgMinutes"
                        stroke="#A855F7"
                        strokeWidth={2}
                        dot={{ fill: '#A855F7', strokeWidth: 2 }}
                        activeDot={{ r: 6, fill: '#A855F7' }}
                        name="Processing Time"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default TaskStatsChart;

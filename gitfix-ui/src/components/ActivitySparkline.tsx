import React from 'react';
import {
  XAxis,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';
import { tooltipStyle } from './chartConstants';

interface ActivitySparklineProps {
  data: Array<{ date: string; displayDate: string; count: number }>;
}

const formatDateShort = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const ActivitySparkline: React.FC<ActivitySparklineProps> = ({ data }) => {
  // Get first and last dates for minimal axis display
  const startDate = data.length > 0 ? formatDateShort(data[0].date) : '';
  const endDate = data.length > 0 ? formatDateShort(data[data.length - 1].date) : '';

  // Custom tick formatter that only shows first and last dates
  const formatTick = (value: string, index: number): string => {
    if (index === 0) return startDate;
    if (index === data.length - 1) return endDate;
    return '';
  };

  return (
    <div className="mb-6">
      {/* Small uppercase header */}
      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Activity (30 Days)
      </h4>

      {/* Sparkline container - no card styling, compact height */}
      <div className="h-[120px]">
        {data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
              <defs>
                {/* Teal gradient fill - fading to transparent */}
                <linearGradient id="sparklineGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#14B8A6" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="#14B8A6" stopOpacity={0} />
                </linearGradient>
              </defs>

              {/* No CartesianGrid - removed for minimalist look */}
              {/* No YAxis - removed for minimalist look */}

              {/* Minimal X-Axis - only show start/end dates */}
              <XAxis
                dataKey="displayDate"
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#9CA3AF', fontSize: 10 }}
                tickFormatter={formatTick}
                interval={0}
                tickMargin={8}
              />

              <Tooltip
                contentStyle={{
                  ...tooltipStyle,
                  padding: '6px 10px',
                  fontSize: '12px',
                }}
                formatter={(value: number) => [`${value} tasks`, '']}
                labelFormatter={(label: string) => label}
              />

              {/* Teal area with gradient fill */}
              <Area
                type="monotone"
                dataKey="count"
                stroke="#14B8A6"
                strokeWidth={2}
                fill="url(#sparklineGradient)"
                dot={false}
                activeDot={{ r: 3, fill: '#14B8A6', stroke: '#FFFFFF', strokeWidth: 1 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex items-center justify-center text-gray-400 text-sm">
            No activity data
          </div>
        )}
      </div>
    </div>
  );
};

export default ActivitySparkline;

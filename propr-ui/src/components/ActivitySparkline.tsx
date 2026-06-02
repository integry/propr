import React from 'react';
import {
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';
import { tooltipStyle } from './chartConstants';

interface ActivitySparklineProps {
  data: Array<{ date: string; displayDate: string; count: number }>;
  isLoading?: boolean;
  deterministicSvg?: boolean;
}

const formatDateShort = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const DeterministicActivityGraph: React.FC<{ data: ActivitySparklineProps['data'] }> = ({ data }) => {
  const width = 300;
  const height = 120;
  const left = 34;
  const right = 8;
  const top = 10;
  const bottom = 24;
  const startDate = data.length > 0 ? formatDateShort(data[0].date) : '';
  const endDate = data.length > 0 ? formatDateShort(data[data.length - 1].date) : '';
  const middleDate = data.length > 0 ? formatDateShort(data[Math.floor(data.length / 2)].date) : '';
  const max = Math.max(...data.map((point) => point.count));
  const min = Math.min(...data.map((point) => point.count));
  const range = Math.max(1, max - min);
  const points = data.map((point, index) => {
    const x = left + (index / Math.max(1, data.length - 1)) * (width - left - right);
    const y = top + (1 - (point.count - min) / range) * (height - top - bottom);
    return { x, y };
  });
  const linePath = points.reduce((path, point, index) => {
    if (index === 0) return `M ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;

    const previous = points[index - 1];
    const controlX = (previous.x + point.x) / 2;
    return `${path} C ${controlX.toFixed(1)} ${previous.y.toFixed(1)}, ${controlX.toFixed(1)} ${point.y.toFixed(1)}, ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
  }, '');
  const areaPath = `${linePath} L ${(width - right).toFixed(1)} ${(height - bottom).toFixed(1)} L ${left.toFixed(1)} ${(height - bottom).toFixed(1)} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-[120px] w-full overflow-visible" aria-hidden="true">
      <defs>
        <linearGradient id="sparklineGradientSvg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#14B8A6" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#14B8A6" stopOpacity="0" />
        </linearGradient>
      </defs>
      <text x="8" y={top + 4} className="fill-slate-400 text-[10px]">{max}</text>
      <text x="8" y={top + (height - top - bottom) / 2 + 4} className="fill-slate-400 text-[10px]">{Math.round(max / 2)}</text>
      <line x1={left} x2={width - right} y1={top} y2={top} className="stroke-slate-200" strokeWidth="1" />
      <line x1={left} x2={width - right} y1={top + (height - top - bottom) / 2} y2={top + (height - top - bottom) / 2} className="stroke-slate-200" strokeWidth="1" />
      <line x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} className="stroke-slate-200" strokeWidth="1" />
      <path d={areaPath} fill="url(#sparklineGradientSvg)" />
      <path d={linePath} fill="none" stroke="#14B8A6" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
      {points.filter((_, index) => index === data.length - 1 || index === data.length - 8 || index === data.length - 15).map((point) => (
        <circle key={`${point.x}-${point.y}`} cx={point.x} cy={point.y} r="3" fill="#14B8A6" stroke="white" strokeWidth="1.5" />
      ))}
      <text x={left} y={height - 4} textAnchor="start" className="fill-slate-400 text-[10px]">{startDate}</text>
      <text x={(left + width - right) / 2} y={height - 4} textAnchor="middle" className="fill-slate-400 text-[10px]">{middleDate}</text>
      <text x={width - right} y={height - 4} textAnchor="end" className="fill-slate-400 text-[10px]">{endDate}</text>
    </svg>
  );
};

const ActivitySparkline: React.FC<ActivitySparklineProps> = ({ data, isLoading = false, deterministicSvg = false }) => {
  // Get first, middle and last dates for minimal axis display
  const startDate = data.length > 0 ? formatDateShort(data[0].date) : '';
  const endDate = data.length > 0 ? formatDateShort(data[data.length - 1].date) : '';
  const middleIndex = Math.floor(data.length / 2);
  const middleDate = data.length > 0 ? formatDateShort(data[middleIndex].date) : '';

  // Calculate max value for Y axis - use exact max, no padding
  const maxCount = data.length > 0 ? Math.max(...data.map(d => d.count)) : 0;
  const yAxisMax = maxCount || 10;
  const yAxisMiddle = Math.round(yAxisMax / 2);

  // Custom tick for X axis - shows first (left-aligned), middle (center), and last (right-aligned)
  const renderXAxisTick = (props: { x: number; y: number; payload: { index: number } }) => {
    const { x, y, payload } = props;
    const index = payload.index;

    let label = '';
    let textAnchor: 'start' | 'middle' | 'end' = 'middle';

    if (index === 0) {
      label = startDate;
      textAnchor = 'start';
    } else if (index === data.length - 1) {
      label = endDate;
      textAnchor = 'end';
    } else if (index === middleIndex) {
      label = middleDate;
      textAnchor = 'middle';
    }

    if (!label) return null;

    return (
      <text
        x={x}
        y={y + 12}
        fill="#9CA3AF"
        fontSize={10}
        textAnchor={textAnchor}
      >
        {label}
      </text>
    );
  };

  // Custom Y axis ticks - show only top and middle
  const yAxisTicks = [yAxisMiddle, yAxisMax];

  return (
    <div>
      {/* Utility header style - small, uppercase, gray, bold */}
      <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">
        Activity (30 Days)
      </h4>

      {/* Sparkline container - no card styling, compact height */}
      <div className="h-[120px]">
        {isLoading ? (
          /* Loading skeleton placeholder for the graph */
          <div className="h-full w-full flex flex-col justify-end pb-4 animate-pulse">
            {/* Simulated bar chart skeleton */}
            <div className="flex items-end justify-between gap-1 h-[80px] px-6">
              {[...Array(15)].map((_, i) => (
                <div
                  key={i}
                  className="flex-1 bg-gray-200 rounded-t"
                  style={{ height: `${20 + Math.random() * 60}%` }}
                />
              ))}
            </div>
            {/* X-axis placeholder */}
            <div className="flex justify-between px-6 mt-2">
              <div className="h-2 w-12 bg-gray-200 rounded" />
              <div className="h-2 w-12 bg-gray-200 rounded" />
              <div className="h-2 w-12 bg-gray-200 rounded" />
            </div>
          </div>
        ) : data.length > 0 && deterministicSvg ? (
          <DeterministicActivityGraph data={data} />
        ) : data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 5, right: 5, left: 25, bottom: 5 }}>
              <defs>
                {/* Teal gradient fill - fading to transparent */}
                <linearGradient id="sparklineGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#14B8A6" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="#14B8A6" stopOpacity={0} />
                </linearGradient>
              </defs>

              {/* No CartesianGrid - removed for minimalist look */}

              {/* Minimal Y-Axis - only show top and middle values */}
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#9CA3AF', fontSize: 10 }}
                ticks={yAxisTicks}
                domain={[0, yAxisMax]}
                width={20}
              />

              {/* Minimal X-Axis - show start (left-aligned), middle, and end (right-aligned) dates */}
              <XAxis
                dataKey="displayDate"
                axisLine={false}
                tickLine={false}
                tick={renderXAxisTick}
                interval={0}
                tickMargin={8}
              />

              <Tooltip
                contentStyle={{
                  ...tooltipStyle,
                  padding: '6px 10px',
                  fontSize: '12px',
                }}
                content={({ active, payload, label }) => {
                  if (active && payload && payload.length) {
                    const value = payload[0].value;
                    return (
                      <div style={{ ...tooltipStyle, padding: '6px 10px', fontSize: '12px' }}>
                        {label}: {value} tasks
                      </div>
                    );
                  }
                  return null;
                }}
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

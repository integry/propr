import React from 'react';
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  Legend,
} from 'recharts';
import { tooltipStyle, axisProps } from './chartConstants';
import { formatPercent, type StatusBreakdownEntry } from './taskStatusBreakdown';

interface VolumeChartProps {
  data: Array<{ displayDate: string; count: number }>;
}

export const VolumeChart: React.FC<VolumeChartProps> = ({ data }) => (
  <ResponsiveContainer width="100%" height="100%">
    <AreaChart data={data}>
      <defs>
        <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%" stopColor="#6366F1" stopOpacity={0.2}/>
          <stop offset="95%" stopColor="#6366F1" stopOpacity={0}/>
        </linearGradient>
      </defs>
      <CartesianGrid strokeDasharray="3 3" stroke="rgba(100, 116, 139, 0.1)" />
      <XAxis dataKey="displayDate" {...axisProps} interval="preserveStartEnd" />
      <YAxis {...axisProps} allowDecimals={false} />
      <Tooltip contentStyle={tooltipStyle} />
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
);

interface ProcessingTimeChartProps {
  data: Array<{ displayDate: string; avgMinutes: number }>;
  showLegend?: boolean;
}

export const ProcessingTimeChart: React.FC<ProcessingTimeChartProps> = ({ data, showLegend = false }) => (
  <ResponsiveContainer width="100%" height="100%">
    <AreaChart data={data}>
      <defs>
        <linearGradient id="colorProcessingTime" x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%" stopColor="#A855F7" stopOpacity={0.2}/>
          <stop offset="95%" stopColor="#A855F7" stopOpacity={0}/>
        </linearGradient>
      </defs>
      <CartesianGrid strokeDasharray="3 3" stroke="rgba(100, 116, 139, 0.1)" />
      <XAxis dataKey="displayDate" {...axisProps} interval="preserveStartEnd" />
      <YAxis {...axisProps} />
      <Tooltip
        contentStyle={tooltipStyle}
        formatter={(value: number | undefined) => [value === undefined ? 'N/A' : `${value.toFixed(1)} min`, 'Avg Time']}
      />
      {showLegend && <Legend wrapperStyle={{ color: '#64748B' }} />}
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
);

interface StatusSegmentedBarProps {
  data: StatusBreakdownEntry[];
}

/**
 * Compact horizontal segmented bar (GitHub language-bar style) with a tabular
 * two-column legend. Replaces the donut: same data in a fraction of the height.
 */
export const StatusSegmentedBar: React.FC<StatusSegmentedBarProps> = ({ data }) => {
  const total = data.reduce((sum, entry) => sum + entry.value, 0);
  return (
    <div>
      <div
        className="flex h-2 w-full gap-[2px] overflow-hidden rounded-sm bg-slate-100"
        role="img"
        aria-label={data.map(entry => `${entry.name} ${formatPercent(entry.percent)}`).join(', ')}
      >
        {data.map(entry => (
          <div
            key={entry.key}
            className="h-full"
            style={{ flex: `${entry.value} 0 0`, minWidth: '3px', backgroundColor: entry.color }}
            title={`${entry.name}: ${entry.value.toLocaleString()} tasks (${formatPercent(entry.percent)})`}
            data-status={entry.key}
          />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5" aria-label="Task status breakdown">
        {data.map(entry => (
          <li key={entry.key} className="flex items-center justify-between gap-2 text-xs min-w-0">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="h-2 w-2 flex-shrink-0 rounded-sm" style={{ backgroundColor: entry.color }} aria-hidden="true" />
              <span className="truncate text-slate-600">{entry.name}</span>
            </span>
            <span className="flex-shrink-0 font-mono tabular-nums text-slate-800">{formatPercent(entry.percent)}</span>
          </li>
        ))}
      </ul>
      <span className="sr-only">{total.toLocaleString()} tasks total</span>
    </div>
  );
};

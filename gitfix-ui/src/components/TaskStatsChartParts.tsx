import React from 'react';
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
import { tooltipStyle, axisProps } from './chartConstants';

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
        formatter={(value: number) => [`${value.toFixed(1)} min`, 'Avg Time']}
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

interface PieChartEntry {
  name: string;
  value: number;
  color: string;
}

interface StatusPieChartProps {
  data: PieChartEntry[];
}

export const StatusPieChart: React.FC<StatusPieChartProps> = ({ data }) => (
  <ResponsiveContainer width="100%" height="100%">
    <PieChart>
      <Pie
        data={data}
        cx="50%"
        cy="50%"
        innerRadius={60}
        outerRadius={90}
        paddingAngle={3}
        dataKey="value"
        labelLine={false}
      >
        {data.map((entry, index) => (
          <Cell key={`cell-${index}`} fill={entry.color} />
        ))}
      </Pie>
      <Tooltip
        contentStyle={tooltipStyle}
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
);

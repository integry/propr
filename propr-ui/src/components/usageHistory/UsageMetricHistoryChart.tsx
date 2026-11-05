/**
 * One metric's usage over its last two periods, drawn small enough for the
 * sidebar overlay. A single series needs no legend: the overlay's title names
 * it. The y-axis is fixed at 0-100% so a 20% session never looks as full as an
 * 80% one, and a dashed rule marks where the current period began, which is
 * where a session or weekly quota drops back to zero.
 */

import React, { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AgentTankHistoryPoint } from '../../api/revertApi';
import { axisProps, tooltipStyle } from '../chartConstants';
import { USAGE_SERIES_COLORS, formatHistoryTick, formatHistoryTime, toChartPoints, type ChartPoint } from './usageHistoryModel';

const LINE_COLOR = USAGE_SERIES_COLORS[0];

interface UsageMetricHistoryChartProps {
  points: AgentTankHistoryPoint[];
  since: number;
  until: number;
  /** Where the current period began. */
  periodStart: number;
  /** The live value the sidebar row shows, so the line ends on it. */
  currentPercent: number;
  height?: number;
}

const HistoryTooltip: React.FC<{ active?: boolean; payload?: Array<{ payload: ChartPoint }> }> = ({ active, payload }) => {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point) return null;
  return (
    <div style={tooltipStyle} className="px-2 py-1 text-[11px] leading-tight">
      <div className="text-slate-500">{formatHistoryTime(point.t)}</div>
      <div className="font-semibold text-slate-800">{Math.round(point.percent * 10) / 10}% used</div>
    </div>
  );
};

const UsageMetricHistoryChart: React.FC<UsageMetricHistoryChartProps> = ({
  points, since, until, periodStart, currentPercent, height = 132,
}) => {
  const data = useMemo(() => toChartPoints(points, since, until, currentPercent), [points, since, until, currentPercent]);
  const span = until - since;
  const ticks = useMemo(() => [since, since + span / 2, until], [since, span, until]);
  const showBoundary = periodStart > since && periodStart < until;

  return (
    <div style={{ height }} className="[&_.recharts-surface]:outline-none [&_.recharts-wrapper]:outline-none" data-testid="usage-metric-history-chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 18, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="usage-metric-history-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={LINE_COLOR} stopOpacity={0.18} />
              <stop offset="100%" stopColor={LINE_COLOR} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="#F1F5F9" />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[since, until]}
            ticks={ticks}
            tickFormatter={value => formatHistoryTick(Number(value), span)}
            stroke={axisProps.stroke}
            tick={{ ...axisProps.tick, fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            interval={0}
            allowDataOverflow
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 50, 100]}
            tickFormatter={value => `${value}%`}
            stroke={axisProps.stroke}
            tick={{ ...axisProps.tick, fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={34}
          />
          {showBoundary && (
            <ReferenceLine
              x={periodStart}
              stroke="#94A3B8"
              strokeDasharray="3 3"
              label={{ value: 'Current period', position: 'insideTopRight', fill: '#64748B', fontSize: 9 }}
            />
          )}
          <Tooltip
            content={<HistoryTooltip />}
            cursor={{ stroke: '#94A3B8', strokeWidth: 1 }}
            isAnimationActive={false}
          />
          <Area
            type="linear"
            dataKey="percent"
            stroke={LINE_COLOR}
            strokeWidth={2}
            fill="url(#usage-metric-history-fill)"
            dot={false}
            activeDot={{ r: 4, stroke: '#FFFFFF', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

export default UsageMetricHistoryChart;

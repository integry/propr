/**
 * Every visible usage series on one 0-100% scale. All metrics are "percent of
 * the quota used", so one axis is honest and nothing needs a second scale; a
 * session line climbing while its weekly line barely moves is the comparison
 * the chart exists for. Lines carry their value from one reading to the next,
 * since a quota holds its last measured level until it is measured again. The
 * dashed 50% and 80% rules are the sidebar's warning and critical levels.
 * Every selected series is drawn; past eight, lines repeat a hue with a dash
 * pattern rather than being left off.
 */

import React, { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { axisProps, tooltipStyle } from '../chartConstants';
import { formatHistoryTick, formatHistoryTime } from '../usageHistory/usageHistoryModel';
import UsageSeriesSwatch from './UsageSeriesSwatch';
import { buildChartRows, type ChartRow, type PlottedSeries } from './usageHistoryView';

interface AgentUsageHistoryChartProps {
  series: PlottedSeries[];
  since: number;
  until: number;
}

function evenTicks(since: number, until: number, count: number): number[] {
  const step = (until - since) / (count - 1);
  return Array.from({ length: count }, (_, index) => Math.round(since + step * index));
}

const UsageTooltip: React.FC<{
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
  series: PlottedSeries[];
}> = ({ active, payload, series }) => {
  const row = active ? payload?.[0]?.payload : undefined;
  if (!row) return null;
  const values = series
    .map(entry => ({ entry, value: row[entry.id] }))
    .filter((item): item is { entry: PlottedSeries; value: number } => typeof item.value === 'number')
    .sort((a, b) => b.value - a.value);
  if (values.length === 0) return null;
  return (
    <div style={tooltipStyle} className="max-w-[260px] px-3 py-2 text-xs">
      <div className="mb-1 font-medium text-slate-500">{formatHistoryTime(row.t)}</div>
      <ul className="space-y-0.5">
        {values.map(({ entry, value }) => (
          <li key={entry.id} className="flex items-center gap-2">
            <UsageSeriesSwatch color={entry.color} dash={entry.dash} />
            <span className="min-w-0 flex-1 truncate text-slate-600">{entry.displayLabel}</span>
            <span className="font-semibold tabular-nums text-slate-800">{Math.round(value * 10) / 10}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const AgentUsageHistoryChart: React.FC<AgentUsageHistoryChartProps> = ({ series, since, until }) => {
  const rows = useMemo(() => buildChartRows(series), [series]);
  const span = until - since;
  const ticks = useMemo(() => evenTicks(since, until, 5), [since, until]);

  return (
    <div className="h-[220px] sm:h-[280px] [&_.recharts-surface]:outline-none [&_.recharts-wrapper]:outline-none" data-testid="agent-usage-history-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid vertical={false} stroke="#F1F5F9" />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[since, until]}
            ticks={ticks}
            interval="preserveStartEnd"
            tickFormatter={value => formatHistoryTick(Number(value), span)}
            stroke={axisProps.stroke}
            tick={{ ...axisProps.tick, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
            allowDataOverflow
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            tickFormatter={value => `${value}%`}
            stroke={axisProps.stroke}
            tick={{ ...axisProps.tick, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <ReferenceLine y={50} stroke="#E2E8F0" strokeDasharray="4 4" />
          <ReferenceLine y={80} stroke="#FECACA" strokeDasharray="4 4" />
          <Tooltip
            content={<UsageTooltip series={series} />}
            cursor={{ stroke: '#94A3B8', strokeWidth: 1 }}
            isAnimationActive={false}
          />
          {series.map(entry => (
            <Line
              key={entry.id}
              type="linear"
              dataKey={entry.id}
              name={entry.displayLabel}
              stroke={entry.color}
              strokeDasharray={entry.dash}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: '#FFFFFF', strokeWidth: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default AgentUsageHistoryChart;

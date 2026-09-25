/**
 * Daily completions for the historical stats panel.
 *
 * A line, not bars. Seven bars with no axis furniture were decoration: the
 * tallest one could have been ten completions or a thousand, and the only way
 * to find out was to hover every column in turn. A trend over days is a
 * continuous quantity anyway, which is what a line says and a row of separated
 * columns does not.
 *
 * So the chart carries the smallest scale that makes its height mean
 * something: a dashed gridline at the period's maximum, carrying that number,
 * and a baseline at zero. Two labels are enough to read any point off the
 * curve to within a completion or two, and the exact figure is still one hover
 * away.
 *
 * Finished days carry no marker at all: a grey dot on every day was texture,
 * not information, and the exact figure for any day is one hover away. Only
 * the day still in progress is marked, in brand teal, so the eye lands on the
 * day that can still change.
 */

import React from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { tooltipStyle } from '../chartConstants';
import { CURRENT_DAY_FILL, dailyPointFill, utcToday } from './chartPalette';

export interface DailyCompletion {
  date: string;
  count: number;
}

const shortDate = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** What recharts hands a dot renderer, narrowed to the parts this one uses. */
interface DotRenderProps {
  cx?: number;
  cy?: number;
  payload?: DailyCompletion;
}

/** A marker on the day still accumulating, and on no other day. */
const renderDot = (today: string) => (props: unknown) => {
  const { cx, cy, payload } = props as DotRenderProps;
  const fill = payload ? dailyPointFill(payload.date, today) : null;
  if (cx === undefined || cy === undefined || !payload || !fill) return <g key={payload?.date} />;
  return (
    <circle
      key={payload.date}
      cx={cx}
      cy={cy}
      r={3.5}
      fill={fill}
      stroke="#FFFFFF"
      strokeWidth={1.5}
    />
  );
};

export const DailyCompletionsChart: React.FC<{ data: DailyCompletion[] }> = ({ data }) => {
  if (data.length === 0) return null;

  const today = utcToday();
  const points = data.map(point => ({ ...point, label: shortDate(point.date) }));
  const first = points[0].label;
  const last = points[points.length - 1].label;
  // The scale is the period's own maximum, never a rounded-up invention: the
  // top gridline has to be a number the data actually reached.
  const max = Math.max(...points.map(point => point.count), 1);

  return (
    <div className="mt-3" data-testid="daily-completions-chart">
      <div className="h-24 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {/*
            The right margin is the marker's own radius plus its halo, not a
            token gutter. The last day carries a filled 3.5px dot with a 1.5px
            white ring, and plotting it against the viewBox edge pushed its
            right half outside the plot area — a teal crescent hanging past the
            vertical that the period toggle and the analytics link sit on.
          */}
          <AreaChart data={points} margin={{ top: 6, right: 8, left: 0, bottom: 10 }}>
            <defs>
              <linearGradient id="dailyCompletionsGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CURRENT_DAY_FILL} stopOpacity={0.18} />
                <stop offset="100%" stopColor={CURRENT_DAY_FILL} stopOpacity={0} />
              </linearGradient>
            </defs>
            {/* Two horizontal rules only: the maximum and the baseline. */}
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#E2E8F0" />
            <XAxis dataKey="label" hide />
            <YAxis
              width={24}
              axisLine={false}
              tickLine={false}
              domain={[0, max]}
              ticks={[0, max]}
              // Both, always: recharts drops an edge tick it thinks will not
              // fit, and the baseline is the one it drops.
              interval={0}
              tick={{ fill: '#94A3B8', fontSize: 10 }}
              allowDecimals={false}
            />
            <Tooltip
              cursor={{ stroke: '#CBD5E1', strokeWidth: 1 }}
              content={({ active, payload, label }) =>
                active && payload && payload.length ? (
                  <div style={{ ...tooltipStyle, padding: '6px 10px', fontSize: '12px' }}>
                    {label}: {payload[0].value} completed
                  </div>
                ) : null
              }
            />
            {/* A seven-point summary reads instantly; a grow animation only delays it. */}
            <Area
              type="monotone"
              dataKey="count"
              stroke={CURRENT_DAY_FILL}
              strokeWidth={2}
              fill="url(#dailyCompletionsGradient)"
              dot={renderDot(today)}
              activeDot={{ r: 4, fill: CURRENT_DAY_FILL, stroke: '#FFFFFF', strokeWidth: 1.5 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {/* The date rail is inset by the y-axis gutter so it sits under the plot. */}
      <div className="flex justify-between pl-6 pr-2 pt-1 text-[10px] text-slate-400">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </div>
  );
};

export default DailyCompletionsChart;

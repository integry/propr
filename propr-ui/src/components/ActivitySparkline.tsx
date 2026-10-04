/**
 * Tasks created per day, as one bar per day.
 *
 * Discrete bars, not a smoothed area: the buckets are whole UTC days, and a
 * monotone curve between them invents values for the hours in between and
 * rounds off the spikes and empty days an operator is looking for. Each bar
 * is exactly one day's count, flat on the zero baseline.
 *
 * History is quiet: a day that has closed is a neutral slate bar, and only
 * today's bar, still accumulating, is brand teal — the dashboard's rule.
 *
 * The scale is the window's own maximum and zero, both always labelled, with
 * a lighter dashed midline between them, so a bar's height can be read to
 * within a task or two without hovering it; the exact figure is still one
 * hover away. The heading belongs to the pane that holds the chart.
 *
 * Every bar that has room gets its own date, directly under it: a week reads
 * as weekdays over days, and a longer window steps at an even stride counted
 * back from today (see `planActivityAxis`). Each day owns its whole column:
 * hovering anywhere in it lights a ceiling-to-baseline track behind the bar
 * and opens that day's count, so the hover target is the day's slot, not a
 * thin bar inside it.
 */

import React, { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartNoAxesColumn, Slash } from 'lucide-react';
import { midlineTick, tooltipStyle } from './chartConstants';
import { dailyBarFill, utcToday } from './Dashboard/chartPalette';
import { planActivityAxis, type ActivityAxisLabel } from './Analytics/activityAxis';
import { SkeletonBlock, SkeletonRegion } from './ui/Skeleton';
import { SystemAlert } from './ui/SystemAlert';

interface ActivitySparklineProps {
  data: Array<{ date: string; displayDate: string; count: number }>;
  isLoading?: boolean;
}

/**
 * Placeholder bar heights, in percent. Fixed so the skeleton holds still
 * across re-renders instead of reshuffling every time its parent updates.
 */
const PLACEHOLDER_BAR_HEIGHTS = [45, 30, 60, 40, 75, 55, 35, 65, 50, 80, 40, 60, 30, 70, 50];

/** The y-axis gutter, which the plot and the skeleton are both inset by. */
const Y_AXIS_WIDTH = 28;

/** The hover track behind a day's bar (slate-100: slate-50 vanishes on the white canvas). */
const COLUMN_TRACK_FILL = '#F1F5F9';

/** One day's date under its bar: the weekday or day on top, the date, month or year beneath. */
const DateTick: React.FC<{ x?: number; y?: number; payload?: { value: string }; labels: Map<string, ActivityAxisLabel> }> = ({
  x = 0, y = 0, payload, labels,
}) => {
  const label = payload ? labels.get(payload.value) : undefined;
  if (!label) return null;
  return (
    <text x={x} y={y} textAnchor="middle" fontSize={10} className="tabular-nums" data-testid="activity-date-label">
      <tspan x={x} dy="0.71em" fill="#64748B">{label.primary}</tspan>
      {label.secondary && <tspan x={x} dy="1.2em" fill="#94A3B8">{label.secondary}</tspan>}
    </text>
  );
};

const ActivitySparkline: React.FC<ActivitySparklineProps> = ({ data, isLoading = false }) => {
  // Never a rounded-up invention: the top rule is a count the window reached.
  const max = Math.max(1, ...data.map(point => point.count));
  const mid = midlineTick(max);
  const today = utcToday();
  const [plotWidth, setPlotWidth] = useState(0);
  const labels = useMemo(
    () => planActivityAxis(data.map(point => point.date), data.length > 0 ? plotWidth / data.length : 0),
    [data, plotWidth],
  );
  const onResize = (width: number) => setPlotWidth(Math.max(0, width - Y_AXIS_WIDTH));

  return (
    <div data-testid="activity-chart">
      <div className="h-48 xl:h-64">
        {isLoading ? (
          <SkeletonRegion label="Loading activity…" className="flex h-full w-full flex-col justify-end pb-7">
            <div className="flex h-[85%] items-end justify-between gap-1 pl-7">
              {PLACEHOLDER_BAR_HEIGHTS.map((height, i) => (
                <SkeletonBlock key={i} className="flex-1" style={{ height: `${height}%` }} />
              ))}
            </div>
          </SkeletonRegion>
        ) : data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%" onResize={onResize}>
            <BarChart data={data} margin={{ top: 6, right: 0, left: 0, bottom: 0 }} barCategoryGap="15%">
              {/*
                The baseline and maximum rules, then a lighter midline that reads
                as a guide. Both are grids, so they sit behind the bars.
              */}
              <CartesianGrid vertical={false} horizontalValues={[0, max]} strokeDasharray="3 3" stroke="#E2E8F0" />
              {mid !== null && (
                <CartesianGrid vertical={false} horizontalValues={[mid]} strokeDasharray="3 3" stroke="#F1F5F9" />
              )}
              <XAxis
                dataKey="date"
                axisLine={false}
                tickLine={false}
                // Every day is a tick; the plan decides which ones carry a date.
                interval={0}
                height={28}
                tick={<DateTick labels={labels} />}
              />
              <YAxis
                width={Y_AXIS_WIDTH}
                axisLine={false}
                tickLine={false}
                domain={[0, max]}
                ticks={mid === null ? [0, max] : [0, mid, max]}
                // Every one, always: recharts drops an edge tick it thinks will
                // not fit, and the baseline is the one it drops.
                interval={0}
                allowDecimals={false}
                tick={{ fill: '#94A3B8', fontSize: 10 }}
              />
              {/* The cursor is the day's whole column, ceiling to baseline. */}
              <Tooltip
                cursor={{ fill: COLUMN_TRACK_FILL }}
                content={({ active, payload }) =>
                  active && payload && payload.length ? (
                    <div style={{ ...tooltipStyle, padding: '6px 10px', fontSize: '12px' }}>
                      {(payload[0].payload as ActivitySparklineProps['data'][number]).displayDate}: {payload[0].value} tasks
                    </div>
                  ) : null
                }
              />
              <Bar dataKey="count" radius={[2, 2, 0, 0]} maxBarSize={40} isAnimationActive={false}>
                {data.map(point => (
                  <Cell key={point.date} fill={dailyBarFill(point.date, today)} data-testid={`activity-bar-${point.date}`} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <SystemAlert
            variant="empty"
            icon={(
              <span className="relative text-slate-300" aria-hidden="true">
                <ChartNoAxesColumn className="h-5 w-5" />
                <Slash className="absolute inset-0 h-5 w-5" />
              </span>
            )}
          >
            No activity data
          </SystemAlert>
        )}
      </div>
    </div>
  );
};

export default ActivitySparkline;

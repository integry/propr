/**
 * Tasks created per day, as one bar per day.
 *
 * Discrete bars, not a smoothed area: the buckets are whole UTC days, and a
 * monotone curve between them invents values for the hours in between and
 * rounds off the spikes and empty days an operator is looking for. Each bar
 * is exactly one day's count, flat on the zero baseline.
 *
 * The scale is the window's own maximum and zero, both always labelled, so a
 * bar's height means something without hovering it; the exact figure is still
 * one hover away. The heading belongs to the pane that holds the chart.
 */

import React from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartNoAxesColumn, Slash } from 'lucide-react';
import { tooltipStyle } from './chartConstants';
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

const BAR_FILL = '#14B8A6';

const ActivitySparkline: React.FC<ActivitySparklineProps> = ({ data, isLoading = false }) => {
  const first = data[0]?.displayDate ?? '';
  const middle = data[Math.floor(data.length / 2)]?.displayDate ?? '';
  const last = data[data.length - 1]?.displayDate ?? '';
  // Never a rounded-up invention: the top rule is a count the window reached.
  const max = Math.max(1, ...data.map(point => point.count));

  return (
    <div data-testid="activity-chart">
      <div className="h-48 xl:h-64">
        {isLoading ? (
          <SkeletonRegion label="Loading activity…" className="flex h-full w-full flex-col justify-end pb-2">
            <div className="flex h-[85%] items-end justify-between gap-1 pl-7">
              {PLACEHOLDER_BAR_HEIGHTS.map((height, i) => (
                <SkeletonBlock key={i} className="flex-1" style={{ height: `${height}%` }} />
              ))}
            </div>
          </SkeletonRegion>
        ) : data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 6, right: 0, left: 0, bottom: 6 }} barCategoryGap="15%">
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="displayDate" hide />
              <YAxis
                width={28}
                axisLine={false}
                tickLine={false}
                domain={[0, max]}
                ticks={[0, max]}
                // Both, always: recharts drops an edge tick it thinks will not
                // fit, and the baseline is the one it drops.
                interval={0}
                allowDecimals={false}
                tick={{ fill: '#94A3B8', fontSize: 10 }}
              />
              <Tooltip
                cursor={{ fill: '#F1F5F9' }}
                content={({ active, payload, label }) =>
                  active && payload && payload.length ? (
                    <div style={{ ...tooltipStyle, padding: '6px 10px', fontSize: '12px' }}>
                      {label}: {payload[0].value} tasks
                    </div>
                  ) : null
                }
              />
              <Bar dataKey="count" fill={BAR_FILL} radius={[2, 2, 0, 0]} maxBarSize={28} isAnimationActive={false} />
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
      {/* The date rail is inset by the y-axis gutter so it sits under the plot. */}
      {!isLoading && data.length > 0 && (
        <div className="flex justify-between pl-7 pt-1 text-[10px] tabular-nums text-slate-400">
          <span>{first}</span>
          {data.length > 2 && <span>{middle}</span>}
          <span>{last}</span>
        </div>
      )}
    </div>
  );
};

export default ActivitySparkline;

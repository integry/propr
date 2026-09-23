/**
 * Daily completions for the historical stats panel.
 *
 * One bar per day, no axis furniture beyond the first and last dates: the
 * panel's job is shape, not precise readings. The numbers themselves are in
 * the metrics above it.
 */

import React from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { tooltipStyle } from '../chartConstants';

export interface DailyCompletion {
  date: string;
  count: number;
}

const shortDate = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const DailyCompletionsChart: React.FC<{ data: DailyCompletion[] }> = ({ data }) => {
  if (data.length === 0) return null;

  const points = data.map(point => ({ ...point, label: shortDate(point.date) }));
  const first = points[0].label;
  const last = points[points.length - 1].label;

  return (
    <div className="mt-3" data-testid="daily-completions-chart">
      <div className="h-20 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
            <XAxis dataKey="label" hide />
            <Tooltip
              cursor={{ fill: '#F1F5F9' }}
              content={({ active, payload, label }) =>
                active && payload && payload.length ? (
                  <div style={{ ...tooltipStyle, padding: '6px 10px', fontSize: '12px' }}>
                    {label}: {payload[0].value} completed
                  </div>
                ) : null
              }
            />
            {/* A seven-bar summary reads instantly; a grow animation only delays it. */}
            <Bar dataKey="count" fill="#14B8A6" radius={[2, 2, 0, 0]} maxBarSize={18} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex justify-between px-0.5 pt-1 text-[10px] text-slate-400">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </div>
  );
};

export default DailyCompletionsChart;

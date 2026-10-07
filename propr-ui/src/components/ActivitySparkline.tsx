/**
 * Runs against tasks per day, as a pair of bars side by side for each day.
 *
 * Each day's left bar is the compute spent that day (agent runs started), and
 * the right one, the same width, is the deliverables (tasks created). Reading
 * the two on one scale is the point: a runs bar towering over its neighbour is
 * an agent iterating on the same work, and one level with it is work landing
 * in a run or two. Side by side, not nested: a dark bar inside a lighter one
 * reads as a fill gauge, as if tasks were a share of runs, and it shrinks the
 * deliverable to a needle. Two separate charts would make the reader carry one
 * day's height across to the other, and would cost the pane its height again.
 * Against a server that reports no runs, the chart draws tasks alone.
 *
 * Discrete bars, not a smoothed area: the buckets are whole UTC days, and a
 * monotone curve between them invents values for the hours in between and
 * rounds off the spikes and empty days an operator is looking for. Each bar
 * is exactly one day's count, flat on the zero baseline.
 *
 * History is quiet: a day that has closed is a neutral slate bar, and only
 * today's bar, still accumulating, is brand teal — the dashboard's rule. In
 * the paired chart runs are always light slate and tasks dark slate, as the
 * legend says; only today's tasks bar, the deliverable, takes the teal.
 *
 * The scale runs from zero to a round ceiling at least 15% above the window's
 * busiest day, both always labelled, with a lighter dashed midline between
 * them, so a bar's height can be read without hovering it. The headroom is for
 * the hover card: the tallest bar stops short of the ceiling, so the card over
 * it stays inside the plot instead of climbing into the legend above, and it
 * never rises past the chart's top edge. A day with any count stands at least
 * a few pixels tall, so a quiet day beside an outlier is still a bar you can
 * see and point at, not a line on the baseline. The exact figures, and the day's
 * runs per task, are still one hover away. The heading belongs to the pane
 * that holds the chart, and the legend with the window's totals sits in it
 * (`ActivityLegend`), so the chart takes no more height than before.
 *
 * Every bar that has room gets its own date, directly under it: a week reads
 * as weekdays over days, and a longer window steps at an even stride counted
 * back from today (see `planActivityAxis`). Each day owns its whole column:
 * hovering anywhere in it lights a ceiling-to-baseline track behind the bar
 * and opens that day's count, so the hover target is the day's slot, not a
 * thin bar inside it. The count stands over the day it describes, centred on
 * the column with a caret down to its tallest bar, rather than flipping to
 * whichever side of the pointer has room and floating over a neighbour.
 */

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartNoAxesColumn, Slash } from 'lucide-react';
import { headroomCeiling, midlineTick, tooltipStyle } from './chartConstants';
import { CURRENT_DAY_FILL, dailyBarFill, utcToday } from './Dashboard/chartPalette';
import { planActivityAxis, type ActivityAxisLabel } from './Analytics/activityAxis';
import { SkeletonBlock, SkeletonRegion } from './ui/Skeleton';
import { SystemAlert } from './ui/SystemAlert';

interface ActivityDay {
  date: string;
  displayDate: string;
  /** Tasks created that day. */
  count: number;
  /** Runs started that day; absent when the server does not report runs. */
  runs?: number;
}

interface ActivitySparklineProps {
  data: ActivityDay[];
  isLoading?: boolean;
}

/**
 * Placeholder bar heights, in percent. Fixed so the skeleton holds still
 * across re-renders instead of reshuffling every time its parent updates.
 */
const PLACEHOLDER_BAR_HEIGHTS = [45, 30, 60, 40, 75, 55, 35, 65, 50, 80, 40, 60, 30, 70, 50];

/** The y-axis gutter, which the plot and the skeleton are both inset by. */
const Y_AXIS_WIDTH = 28;
/** The space above the plot, and the date axis beneath it. */
const PLOT_TOP = 12;
const X_AXIS_HEIGHT = 28;
/** How far the tooltip's caret stands off the top of the bar it points at. */
const CARET_SIZE = 6;
/**
 * How tall the hover card stands over its bar, caret included: two 16px lines,
 * 4px of padding either side and the border. The ceiling leaves this much room
 * above the tallest bar, less the space already above the plot.
 */
const CARD_CLEARANCE = 2 * 16 + 2 * 4 + 2 + CARET_SIZE;
/** The least headroom over the busiest day, as a share of it. */
const MIN_HEADROOM = 0.15;
/**
 * The headroom the busiest day needs for its card to fit between its bar and
 * the chart's top edge, at least `MIN_HEADROOM`. Before the plot is measured,
 * and on one too short to spare the room, the minimum stands; the card then
 * clamps to the top edge rather than climbing over the legend.
 */
const headroomFor = (plotHeight: number): number => {
  const clearance = CARD_CLEARANCE - PLOT_TOP;
  if (plotHeight <= clearance * 2) return MIN_HEADROOM;
  return Math.max(MIN_HEADROOM, plotHeight / (plotHeight - clearance) - 1);
};
/** The shortest a bar with any count stands, in pixels; an empty day draws none. */
const MIN_BAR_HEIGHT = 4;
const minBarHeight = (value: number | undefined | null): number => (value ? MIN_BAR_HEIGHT : 0);

/** The hover track behind a day's bar (slate-100: slate-50 vanishes on the white canvas). */
const COLUMN_TRACK_FILL = '#F1F5F9';

/**
 * Runs, every day including today (slate-300, the settled-day slate). Any
 * paler and a bar melts into the slate-100 hover track.
 */
const RUNS_FILL = '#CBD5E1';
/** Tasks on a closed day (slate-700); today's is brand teal. */
const TASKS_FILL = '#334155';
/** The widest either bar of a pair gets, in pixels, and the gap between them. */
const PAIRED_BAR_SIZE = 14;
const PAIRED_BAR_GAP = 3;
/** The share of a day's slot its pair may fill, leaving the `barCategoryGap` either side. */
const PAIRED_SLOT_SHARE = 0.7;

/**
 * Each bar's width in a day's pair. Set outright, not as a `maxBarSize`: a
 * capped bar is centred in its half of the slot, and the pair drifts apart.
 */
const pairedBarSize = (slot: number): number =>
  Math.max(1, Math.min(PAIRED_BAR_SIZE, Math.floor((slot * PAIRED_SLOT_SHARE - PAIRED_BAR_GAP) / 2)));

/**
 * How far a day's pair sits off its slot's centre. Recharts truncates the
 * pair's inset to a whole pixel, so the pair can sit up to a pixel left of
 * centre; the date and the card follow the pair, not the slot.
 */
const pairDrift = (slot: number, barSize: number): number => {
  const inset = (slot - (2 * barSize + PAIRED_BAR_GAP)) / 2;
  return Math.trunc(inset) - inset;
};

/** Whether the days carry runs, so the chart can pair them with tasks. */
const hasRuns = (data: ActivityDay[]): boolean => data.some(day => day.runs !== undefined);

const formatRatio = (runs: number, tasks: number): string | null =>
  tasks > 0 ? `${(runs / tasks).toFixed(1)}× runs per task` : null;

/**
 * The key to the paired chart, with each series' total over the window, for
 * the pane heading. Nothing without runs: a single series needs no key.
 */
export const ActivityLegend: React.FC<{ data: ActivityDay[] }> = ({ data }) => {
  if (!hasRuns(data)) return null;
  const runs = data.reduce((sum, day) => sum + (day.runs ?? 0), 0);
  const tasks = data.reduce((sum, day) => sum + day.count, 0);
  const swatch = (fill: string) => (
    <span className="inline-block h-2.5 w-2.5 flex-none rounded-sm" style={{ backgroundColor: fill }} aria-hidden="true" />
  );
  return (
    <ul className="flex items-center gap-3 text-[11px] text-slate-500" aria-label="Activity legend" data-testid="activity-legend">
      <li className="flex items-center gap-1.5" title="Agent runs started: the compute spent">
        {swatch(RUNS_FILL)}Runs <span className="font-semibold tabular-nums text-slate-700">{runs.toLocaleString()}</span>
      </li>
      <li className="flex items-center gap-1.5" title="Tasks created: the deliverables">
        {swatch(TASKS_FILL)}Tasks <span className="font-semibold tabular-nums text-slate-700">{tasks.toLocaleString()}</span>
      </li>
    </ul>
  );
};

/**
 * A day's figures, centred over its column with a caret down to the top of
 * its taller bar. Recharts pins its wrapper at the chart's corner (`position`
 * below), so `x` and `y` are the anchor in chart pixels. Near either edge the
 * box slides to stay over the plot; the caret stays on the column. It never
 * rises above the chart's top edge, where the pane's legend sits.
 */
const AnchoredTooltip: React.FC<{ x: number; y: number; minX: number; maxX: number; children: React.ReactNode }> = ({
  x, y, minX, maxX, children,
}) => {
  const box = useRef<HTMLDivElement>(null);
  const [{ width, height }, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (box.current) setBox({ width: box.current.offsetWidth, height: box.current.offsetHeight });
  }, [children]);
  const left = Math.max(minX, Math.min(x - width / 2, maxX - width));
  const top = Math.max(0, y - CARET_SIZE - height);
  return (
    <div
      ref={box}
      data-testid="activity-tooltip"
      // The card hangs over its neighbours' columns: the pointer passes
      // straight through it to the day beneath rather than catching on it.
      className="pointer-events-none select-none"
      style={{
        ...tooltipStyle,
        position: 'absolute',
        left,
        top,
        whiteSpace: 'nowrap',
        padding: '4px 8px',
        fontSize: '12px',
        lineHeight: '16px',
        visibility: width > 0 ? 'visible' : 'hidden',
      }}
    >
      {children}
      {/* The caret: a square turned on its corner, its lower half below the box. */}
      <span
        aria-hidden="true"
        data-testid="activity-tooltip-caret"
        style={{
          position: 'absolute',
          left: x - left - CARET_SIZE / Math.SQRT2,
          bottom: -CARET_SIZE / Math.SQRT2 - 1,
          width: CARET_SIZE * Math.SQRT2,
          height: CARET_SIZE * Math.SQRT2,
          backgroundColor: tooltipStyle.backgroundColor,
          borderRight: tooltipStyle.border,
          borderBottom: tooltipStyle.border,
          transform: 'rotate(45deg)',
        }}
      />
    </div>
  );
};

/** One day's date under its bar: the weekday or day on top, the date, month or year beneath. */
const DateTick: React.FC<{
  x?: number; y?: number; payload?: { value: string }; labels: Map<string, ActivityAxisLabel>; drift?: number;
}> = ({
  x: slotCentre = 0, y = 0, payload, labels, drift = 0,
}) => {
  const x = slotCentre + drift;
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
  const paired = hasRuns(data);
  const today = utcToday();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const plotWidth = Math.max(0, size.width - Y_AXIS_WIDTH);
  const plotHeight = Math.max(0, size.height - PLOT_TOP - X_AXIS_HEIGHT);
  const busiest = Math.max(0, ...data.map(point => Math.max(point.count, point.runs ?? 0)));
  const max = headroomCeiling(busiest, headroomFor(plotHeight));
  const mid = midlineTick(max);
  const slot = data.length > 0 ? plotWidth / data.length : 0;
  const labels = useMemo(() => planActivityAxis(data.map(point => point.date), slot), [data, slot]);
  const barSize = pairedBarSize(slot);
  const drift = paired ? pairDrift(slot, barSize) : 0;
  const onResize = (width: number, height: number) => setSize({ width, height });

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
            <BarChart data={data} margin={{ top: PLOT_TOP, right: 0, left: 0, bottom: 0 }} barCategoryGap="15%" barGap={PAIRED_BAR_GAP}>
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
                height={X_AXIS_HEIGHT}
                tick={<DateTick labels={labels} drift={drift} />}
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
              {/*
                Pinned to the chart's corner so the card can place itself over
                its day: recharts would otherwise push it beside the pointer.
              */}
              <Tooltip
                cursor={{ fill: COLUMN_TRACK_FILL }}
                position={{ x: 0, y: 0 }}
                wrapperStyle={{ pointerEvents: 'none' }}
                isAnimationActive={false}
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const day = payload[0].payload as ActivityDay;
                  const index = data.findIndex(point => point.date === day.date);
                  const top = Math.max(day.count, day.runs ?? 0);
                  const ratio = paired ? formatRatio(day.runs ?? 0, day.count) : null;
                  return (
                    <AnchoredTooltip
                      x={Y_AXIS_WIDTH + (index + 0.5) * slot + drift}
                      y={PLOT_TOP + plotHeight - Math.max(plotHeight * (top / max), minBarHeight(top))}
                      minX={Y_AXIS_WIDTH}
                      maxX={size.width}
                    >
                      {paired
                        ? <>{day.displayDate}: {(day.runs ?? 0).toLocaleString()} runs · {day.count.toLocaleString()} tasks</>
                        : <>{day.displayDate}: {day.count} tasks</>}
                      {ratio && <div className="text-slate-500">{ratio}</div>}
                    </AnchoredTooltip>
                  );
                }}
              />
              {paired ? (
                [
                  <Bar key="runs" dataKey="runs" name="Runs" radius={[2, 2, 0, 0]} barSize={barSize} minPointSize={minBarHeight} isAnimationActive={false}>
                    {data.map(point => (
                      <Cell key={point.date} fill={RUNS_FILL} data-testid={`activity-runs-bar-${point.date}`} />
                    ))}
                  </Bar>,
                  <Bar key="tasks" dataKey="count" name="Tasks" radius={[2, 2, 0, 0]} barSize={barSize} minPointSize={minBarHeight} isAnimationActive={false}>
                    {data.map(point => (
                      <Cell
                        key={point.date}
                        fill={point.date === today ? CURRENT_DAY_FILL : TASKS_FILL}
                        data-testid={`activity-tasks-bar-${point.date}`}
                      />
                    ))}
                  </Bar>,
                ]
              ) : (
                <Bar dataKey="count" radius={[2, 2, 0, 0]} maxBarSize={40} minPointSize={minBarHeight} isAnimationActive={false}>
                  {data.map(point => (
                    <Cell key={point.date} fill={dailyBarFill(point.date, today)} data-testid={`activity-bar-${point.date}`} />
                  ))}
                </Bar>
              )}
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

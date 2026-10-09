// Shared chart styling constants

export const tooltipStyle = {
  backgroundColor: '#FFFFFF',
  border: '1px solid #E2E8F0',
  borderRadius: '8px',
  color: '#1E293B',
  boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)',
};

export const axisProps = {
  stroke: '#64748B',
  tick: { fill: '#64748B', fontSize: 12 },
};

/**
 * The midline between zero and a chart's maximum, as a whole count, or null
 * when the maximum is too small to have a distinct one.
 */
export const midlineTick = (max: number): number | null => {
  const mid = Math.round(max / 2);
  return mid > 0 && mid < max ? mid : null;
};

/** The round figures a ceiling may land on, within each power of ten. */
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10];

/**
 * A chart's top rule: the smallest round count at least `headroom` above the
 * maximum, so the tallest bar stops short of the ceiling and a card over it
 * has room inside the plot. 571 runs reads to 700, 8 tasks to 10.
 */
export const headroomCeiling = (max: number, headroom = 0.15): number => {
  const target = Math.max(1, max) * (1 + headroom);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const nice = NICE_STEPS.map(step => step * magnitude).find(value => value >= target && Number.isInteger(value));
  return nice ?? Math.ceil(target);
};

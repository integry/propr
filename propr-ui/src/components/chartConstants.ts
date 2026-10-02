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

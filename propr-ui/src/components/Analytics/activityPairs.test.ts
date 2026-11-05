import { describe, expect, it } from 'vitest';
import { PAIRED_BAR_GAP, PAIRED_BAR_SIZE, PAIRED_SLOT_SHARE, pairDrift, pairedBarGeometry } from './activityPairs';

/** The y-axis gutter the plot is inset by, as the chart lays it out. */
const Y_AXIS_WIDTH = 28;
const slotFor = (chartWidth: number, days: number) => (chartWidth - Y_AXIS_WIDTH) / days;

describe('pairedBarGeometry', () => {
  it('gives a week two full bars and the full gap', () => {
    expect(pairedBarGeometry(slotFor(900, 7))).toEqual({ barSize: PAIRED_BAR_SIZE, gap: PAIRED_BAR_GAP });
  });

  // A phone, a narrow pane, and a wide desktop pane; a week, a month, a
  // quarter, a year and all time (as many days as the server lists).
  const widths = [280, 340, 600, 1200];
  const densities = [7, 30, 90, 365, 1000];
  for (const width of widths) {
    for (const days of densities) {
      it(`keeps every pair inside its own day at ${days} days across ${width}px`, () => {
        const slot = slotFor(width, days);
        const pair = pairedBarGeometry(slot);
        const pairWidth = 2 * pair.barSize + pair.gap;
        // The pair fits its share of the slot, so it never reaches a neighbour's column.
        expect(pairWidth).toBeLessThanOrEqual(slot * PAIRED_SLOT_SHARE + 1e-9);
        // Each bar is still drawn, and the gap never outgrows the bars.
        expect(pair.barSize).toBeGreaterThan(0);
        expect(pair.gap).toBeLessThanOrEqual(PAIRED_BAR_GAP);
        expect(pair.gap).toBeLessThanOrEqual(pair.barSize);
        // Recharts' whole-pixel inset moves the pair under a pixel, and only left.
        const drift = pairDrift(slot, pair);
        expect(drift).toBeLessThanOrEqual(0);
        expect(drift).toBeGreaterThan(-1);
      });
    }
  }

  it('lets the gap give way before the bars when a day gets only a few pixels', () => {
    // 365 days across 1,200px: a 3.2px slot leaves 2.25px of room, too little for a gap.
    expect(pairedBarGeometry(slotFor(1200, 365))).toEqual({ barSize: 1, gap: 0 });
    // A quarter on a phone fares the same.
    expect(pairedBarGeometry(slotFor(340, 90))).toEqual({ barSize: 1, gap: 0 });
    // An 8px slot has room for a 1px gap between 2px bars, not the full 3px.
    expect(pairedBarGeometry(8)).toEqual({ barSize: 2, gap: 1 });
  });

  it('draws sub-pixel bars rather than spill over a neighbour when a day is under three pixels', () => {
    // A year on a phone: under a pixel a day.
    const slot = slotFor(340, 365);
    expect(slot).toBeLessThan(1);
    const pair = pairedBarGeometry(slot);
    expect(pair.gap).toBe(0);
    expect(pair.barSize).toBeCloseTo(slot * PAIRED_SLOT_SHARE / 2);
  });
});

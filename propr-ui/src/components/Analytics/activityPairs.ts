/**
 * How wide each bar of the activity chart's daily pair is, and the gap between
 * them, for the width a day's slot gets.
 *
 * A week has room for two full bars and a clear gap. A year or all time on a
 * narrow pane can leave a day only a pixel or two, where two whole-pixel bars
 * and a fixed gap would be wider than the day itself and spill over their
 * neighbours. So the gap gives way first, then the bars, and below two pixels
 * of room the bars are fractions of a pixel: a pair never leaves its own day's
 * column, whatever the density.
 *
 * A pure function of the slot, so it can be tested without laying out a chart.
 */

/** The widest either bar of a pair gets, in pixels, and the widest gap between them. */
export const PAIRED_BAR_SIZE = 14;
export const PAIRED_BAR_GAP = 3;
/** The share of a day's slot its pair may fill, leaving the `barCategoryGap` either side. */
export const PAIRED_SLOT_SHARE = 0.7;

export interface PairedBarGeometry {
  /** Each bar's width, in pixels. */
  barSize: number;
  /** The space between the runs bar and the tasks bar, in pixels. */
  gap: number;
}

/**
 * The pair for one slot: `2 × barSize + gap` never exceeds the slot's share.
 * The gap is at most a fifth of the room, so it never outgrows the bars.
 */
export function pairedBarGeometry(slot: number): PairedBarGeometry {
  const room = Math.max(0, slot) * PAIRED_SLOT_SHARE;
  // Too narrow for two whole pixels: two halves of the room, touching.
  if (room < 2) return { barSize: room / 2, gap: 0 };
  const gap = Math.min(PAIRED_BAR_GAP, Math.floor(room / 5));
  return { barSize: Math.min(PAIRED_BAR_SIZE, Math.floor((room - gap) / 2)), gap };
}

/**
 * How far a day's pair sits off its slot's centre. Recharts truncates the
 * pair's inset to a whole pixel, so the pair can sit up to a pixel left of
 * centre; the date and the card follow the pair, not the slot.
 */
export function pairDrift(slot: number, { barSize, gap }: PairedBarGeometry): number {
  const inset = (slot - (2 * barSize + gap)) / 2;
  return Math.trunc(inset) - inset;
}

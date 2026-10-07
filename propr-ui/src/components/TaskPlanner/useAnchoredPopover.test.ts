import { describe, expect, it } from 'vitest';
import { computePopoverPosition } from './useAnchoredPopover';

const viewport = { width: 1440, height: 900 };

describe('computePopoverPosition', () => {
  it('opens below the trigger when the content fits', () => {
    expect(computePopoverPosition({ top: 100, bottom: 124, right: 1400 }, 300, viewport))
      .toEqual({ top: 128, right: 40, maxHeight: 900 - 124 - 4 - 8 });
  });

  it('flips above a trigger near the bottom edge so the controls stay on screen', () => {
    const position = computePopoverPosition({ top: 860, bottom: 884, right: 1400 }, 300, viewport);
    expect(position).toEqual({ bottom: 900 - 860 + 4, right: 40, maxHeight: 860 - 4 - 8 });
  });

  it('bounds the height to the roomier side when the content fits on neither', () => {
    const below = computePopoverPosition({ top: 300, bottom: 324, right: 1400 }, 2000, viewport);
    expect(below.top).toBe(328);
    expect(below.maxHeight).toBe(900 - 324 - 4 - 8);
    const above = computePopoverPosition({ top: 600, bottom: 624, right: 1400 }, 2000, viewport);
    expect(above.bottom).toBe(304);
    expect(above.maxHeight).toBe(600 - 4 - 8);
  });

  it('keeps a margin from the right edge', () => {
    expect(computePopoverPosition({ top: 0, bottom: 20, right: 1440 }, 10, viewport).right).toBe(8);
  });
});

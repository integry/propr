import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ActivitySparkline from './ActivitySparkline';
import { midlineTick } from './chartConstants';

const barHeights = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-skeleton-block].flex-1')).map(bar => bar.style.height);

describe('ActivitySparkline', () => {
  it('draws the same placeholder bars on every render', () => {
    const { container, rerender } = render(<ActivitySparkline data={[]} isLoading />);
    const first = barHeights(container);
    expect(first).toHaveLength(15);
    expect(new Set(first).size).toBeGreaterThan(1);

    rerender(<ActivitySparkline data={[]} isLoading />);
    expect(barHeights(container)).toEqual(first);

    const { container: second } = render(<ActivitySparkline data={[]} isLoading />);
    expect(barHeights(second)).toEqual(first);
  });

  it('speaks for itself when no page status is around it', () => {
    render(<ActivitySparkline data={[]} isLoading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading activity…');
  });

  it('labels a midline between zero and the maximum when there is a whole count for it', () => {
    expect(midlineTick(8)).toBe(4);
    expect(midlineTick(5)).toBe(3);
    expect(midlineTick(2)).toBe(1);
    // Too small a range has no distinct midline.
    expect(midlineTick(1)).toBeNull();
  });
});

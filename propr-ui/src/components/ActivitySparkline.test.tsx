import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ActivitySparkline, { ActivityLegend } from './ActivitySparkline';
import { headroomCeiling, midlineTick } from './chartConstants';

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

  it('rounds the ceiling up to a whole count at least 15% over the busiest day', () => {
    expect(headroomCeiling(571)).toBe(700);
    expect(headroomCeiling(8)).toBe(10);
    expect(headroomCeiling(90)).toBe(120);
    expect(headroomCeiling(1)).toBe(2);
    // An empty window still has a scale.
    expect(headroomCeiling(0)).toBe(2);
    // More headroom when the card over the tallest bar needs it.
    expect(headroomCeiling(571, 0.3)).toBe(800);
  });

  it('keys the layered chart with each series total over the window', () => {
    render(<ActivityLegend data={[
      { date: '2026-10-06', displayDate: 'Oct 6', count: 210, runs: 571 },
      { date: '2026-10-07', displayDate: 'Oct 7', count: 60, runs: 180 },
    ]} />);
    const legend = screen.getByTestId('activity-legend');
    expect(legend).toHaveTextContent('Runs 751');
    expect(legend).toHaveTextContent('Tasks 270');
  });

  it('draws no key when the server reports no runs, since tasks are the only series', () => {
    const { container } = render(<ActivityLegend data={[{ date: '2026-10-07', displayDate: 'Oct 7', count: 4 }]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

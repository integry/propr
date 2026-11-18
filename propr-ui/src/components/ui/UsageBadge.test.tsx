import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { UsageMetricRecord } from '@propr/shared';
import { UsageBadge } from './UsageBadge';

const metric = (metricKey: string, metricValue: number): UsageMetricRecord =>
  ({ agent: 'gemini', metricKey, metricValue } as unknown as UsageMetricRecord);

describe('UsageBadge', () => {
  it('renders each part as a whole item with a border separator and no separator text', () => {
    render(
      <UsageBadge
        tokens={1540}
        cost={0.0123}
        usageMetricRecords={[metric('weekly_limit', 1.5), metric('daily_limit', -0.4)]}
      />,
    );
    const badge = screen.getByTestId('usage-badge');
    const parts = screen.getAllByTestId('usage-badge-part');
    expect(parts).toHaveLength(4);
    // No text separators: a wrapped line can never start or end with a stray "|" or "·".
    expect(badge.textContent).not.toMatch(/[|·]/);
    for (const part of parts) {
      // A part never breaks inside; the separator is its left border.
      expect(part).toHaveClass('whitespace-nowrap', 'border-l');
    }
    // The list sits 1px under the badge's clipped left edge, so the border of the
    // part that starts a line (the first, or one that wrapped) is hidden.
    expect(badge).toHaveClass('overflow-hidden');
    expect(parts[0].parentElement).toHaveClass('-ml-px', 'flex-wrap');
    expect(parts[0]).toHaveTextContent('1.5k tok');
    expect(parts[1]).toHaveTextContent('$0.012');
  });

  it('skips zero metrics and renders nothing without usage', () => {
    const { container, rerender } = render(<UsageBadge tokens={0} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<UsageBadge tokens={10} usageMetricRecords={[metric('weekly_limit', 0)]} />);
    expect(screen.getAllByTestId('usage-badge-part')).toHaveLength(1);
  });
});

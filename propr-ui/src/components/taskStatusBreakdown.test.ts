import { describe, expect, it } from 'vitest';
import { buildStatusBreakdown, formatPercent } from './taskStatusBreakdown';

describe('buildStatusBreakdown', () => {
  it('merges execution states, drops empty ones, and sorts by share', () => {
    const result = buildStatusBreakdown([
      { status: 'completed', count: 90 },
      { status: 'claude_execution', count: 3 },
      { status: 'processing', count: 2 },
      { status: 'pending', count: 0 },
      { status: 'failed', count: 5 },
    ]);
    expect(result.map(entry => [entry.name, entry.value, entry.percent])).toEqual([
      ['Completed', 90, 90],
      ['Failed', 5, 5],
      ['Implementing', 5, 5],
    ]);
  });

  it('labels unknown states readably', () => {
    expect(buildStatusBreakdown([{ status: 'awaiting_review', count: 1 }])[0].name).toBe('Awaiting review');
  });
});

describe('formatPercent', () => {
  it('keeps slivers visible in the legend', () => {
    expect(formatPercent(0.04)).toBe('<0.1%');
    expect(formatPercent(96.7823)).toBe('96.8%');
    expect(formatPercent(12.5)).toBe('12.5%');
    expect(formatPercent(90)).toBe('90%');
  });
});

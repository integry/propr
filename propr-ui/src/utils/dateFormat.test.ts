import { describe, expect, it } from 'vitest';
import { formatCount, formatDate, formatDateTime, formatRelativeTime, parseDate } from './dateFormat';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('formatRelativeTime', () => {
  it('reads the last 7 days as a compact relative age', () => {
    expect(formatRelativeTime(ago(20_000), NOW)).toBe('just now');
    expect(formatRelativeTime(ago(5 * 60_000), NOW)).toBe('5m ago');
    expect(formatRelativeTime(ago(2 * 3_600_000 + 59 * 60_000), NOW)).toBe('2h ago');
    expect(formatRelativeTime(ago(46 * 3_600_000), NOW)).toBe('1d ago');
    expect(formatRelativeTime(ago(3 * 86_400_000), NOW)).toBe('3d ago');
  });

  it('reads the near future the same way', () => {
    expect(formatRelativeTime(new Date(NOW + 2 * 3_600_000).toISOString(), NOW)).toBe('in 2h');
  });

  it('switches to a calendar date after 7 days', () => {
    const old = '2026-11-02T10:12:47Z';
    expect(formatRelativeTime(old, NOW)).toBe(formatDate(old));
    expect(formatDate(old)).toMatch(/Nov 2, 2026/);
  });

  it('renders nothing for missing or unparseable input', () => {
    expect(formatRelativeTime(null, NOW)).toBe('');
    expect(formatRelativeTime('not a date', NOW)).toBe('');
    expect(parseDate('')).toBeNull();
  });
});

describe('formatDateTime', () => {
  it('includes the date and the time to the second', () => {
    expect(formatDateTime('2026-11-02T10:12:47')).toMatch(/Nov 2, 2026.*10:12:47/);
  });
});

describe('formatCount', () => {
  it('uses the locale thousands separator', () => {
    expect(formatCount(165297)).toBe((165297).toLocaleString());
    expect(formatCount(undefined)).toBe('—');
  });
});

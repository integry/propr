import { describe, expect, it } from 'vitest';
import { planActivityAxis } from './activityAxis';

/** `count` consecutive UTC day keys ending on `last`. */
const days = (count: number, last = '2026-09-23'): string[] => Array.from({ length: count }, (_, index) =>
  new Date(Date.parse(`${last}T00:00:00Z`) - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10));

describe('planActivityAxis', () => {
  it('labels every day of a week with its weekday over its day, naming the month where it changes', () => {
    const week = days(8);
    const labels = planActivityAxis(week, 100);
    expect([...labels.keys()]).toEqual(week);
    expect(labels.get('2026-09-16')).toEqual({ primary: 'Wed', secondary: 'Sep 16' });
    expect(labels.get('2026-09-17')).toEqual({ primary: 'Thu', secondary: '17' });
    expect(labels.get('2026-09-23')).toEqual({ primary: 'Wed', secondary: '23' });

    const turn = planActivityAxis(days(8, '2026-10-02'), 30);
    expect(turn.get('2026-09-30')).toEqual({ primary: 'Wed', secondary: '30' });
    expect(turn.get('2026-10-01')).toEqual({ primary: 'Thu', secondary: 'Oct 1' });
  });

  it('labels every day of a month that has room, naming the month where it changes', () => {
    const month = days(31, '2026-10-01');
    const labels = planActivityAxis(month, 25);
    expect(labels.size).toBe(31);
    expect(labels.get('2026-09-01')).toEqual({ primary: '1', secondary: 'Sep' });
    expect(labels.get('2026-09-02')).toEqual({ primary: '2' });
    expect(labels.get('2026-10-01')).toEqual({ primary: '1', secondary: 'Oct' });
  });

  it('steps at an even stride counted back from today when every day does not fit', () => {
    const month = days(31);
    // Every other day, ending on today, where a day number has two slots.
    const alternate = [...planActivityAxis(month, 9).keys()];
    expect(alternate).toHaveLength(16);
    expect(alternate.slice(-3)).toEqual(['2026-09-19', '2026-09-21', '2026-09-23']);
    const labels = [...planActivityAxis(month, 5).keys()];
    // Weekly, ending on today.
    expect(labels).toEqual(['2026-08-26', '2026-09-02', '2026-09-09', '2026-09-16', '2026-09-23']);
  });

  it('steps by month across a year, and names the year where it changes', () => {
    const year = days(366, '2026-09-23');
    const labels = planActivityAxis(year, 2.2);
    expect(labels.size).toBe(12);
    expect(labels.get('2025-10-01')).toEqual({ primary: 'Oct', secondary: '2025' });
    expect(labels.get('2025-11-01')).toEqual({ primary: 'Nov' });
    expect(labels.get('2026-01-01')).toEqual({ primary: 'Jan', secondary: '2026' });
  });

  it('labels nothing before the chart has a width', () => {
    expect(planActivityAxis(days(8), 0).size).toBe(0);
    expect(planActivityAxis([], 40).size).toBe(0);
  });
});

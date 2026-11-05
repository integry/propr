import { describe, expect, it } from 'vitest';
import { formatActivityDate, planActivityAxis } from './activityAxis';

/** `count` consecutive UTC day keys ending on `last`. */
const days = (count: number, last = '2026-09-23'): string[] => Array.from({ length: count }, (_, index) =>
  new Date(Date.parse(`${last}T00:00:00Z`) - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10));

/** `count` consecutive UTC hour keys ending at `last`, as the API keys hour buckets. */
const hours = (count: number, last = '2026-09-23T12:00:00.000Z'): string[] => Array.from({ length: count }, (_, index) =>
  new Date(Date.parse(last) - (count - 1 - index) * 3_600_000).toISOString());

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

  it('labels every hour of a day with its clock time, dating the first and where the day turns', () => {
    const day = hours(24);
    const labels = planActivityAxis(day, 40);
    expect([...labels.keys()]).toEqual(day);
    expect(labels.get('2026-09-22T13:00:00.000Z')).toEqual({ primary: '13:00', secondary: 'Sep 22' });
    expect(labels.get('2026-09-22T14:00:00.000Z')).toEqual({ primary: '14:00' });
    expect(labels.get('2026-09-23T00:00:00.000Z')).toEqual({ primary: '00:00', secondary: 'Sep 23' });
    expect(labels.get('2026-09-23T12:00:00.000Z')).toEqual({ primary: '12:00' });
  });

  it('steps the hours at an even stride counted back from this hour when every hour does not fit', () => {
    const day = hours(24);
    // Every third hour, ending on this one, where a clock time needs three slots.
    const stepped = [...planActivityAxis(day, 12).keys()];
    expect(stepped).toHaveLength(8);
    expect(stepped.slice(-2)).toEqual(['2026-09-23T09:00:00.000Z', '2026-09-23T12:00:00.000Z']);
    // The date follows the first label, which need not be the first hour.
    expect(planActivityAxis(day, 12).get('2026-09-22T15:00:00.000Z')).toEqual({ primary: '15:00', secondary: 'Sep 22' });
    // Every sixth, then every twelfth; past that nothing fits.
    expect([...planActivityAxis(day, 6).keys()]).toHaveLength(4);
    expect([...planActivityAxis(day, 3).keys()]).toEqual(['2026-09-23T00:00:00.000Z', '2026-09-23T12:00:00.000Z']);
    expect(planActivityAxis(day, 2).size).toBe(0);
  });

  it('names a day bucket by its date and an hour bucket by its date and UTC clock time', () => {
    expect(formatActivityDate('2026-09-23')).toBe('Sep 23');
    expect(formatActivityDate('2026-09-23T09:00:00.000Z')).toBe('Sep 23, 09:00 UTC');
  });

  it('labels nothing before the chart has a width', () => {
    expect(planActivityAxis(days(8), 0).size).toBe(0);
    expect(planActivityAxis([], 40).size).toBe(0);
  });
});

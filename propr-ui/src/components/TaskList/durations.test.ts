/**
 * How long something took, read rather than computed.
 *
 * `240m 00s` is the regression these cases exist for: a minute count printed
 * straight out of the arithmetic, leaving the reader to divide by sixty to
 * learn that a task has been running for four hours.
 */

import { describe, expect, it } from 'vitest';

import { formatDuration } from './utils.tsx';

const START = '2026-09-23T08:00:00.000Z';
const after = (ms: number): string => new Date(Date.parse(START) + ms).toISOString();

const minutes = (count: number): number => count * 60_000;
const hours = (count: number): number => count * 60 * 60_000;

describe('formatDuration', () => {
  it('counts seconds while minutes are what a run is measured in', () => {
    expect(formatDuration(START, after(0))).toBe('0m 00s');
    expect(formatDuration(START, after(9_000))).toBe('0m 09s');
    expect(formatDuration(START, after(minutes(45) + 12_000))).toBe('45m 12s');
    expect(formatDuration(START, after(minutes(59) + 59_000))).toBe('59m 59s');
  });

  it('hands over to hours the moment minutes are whole', () => {
    expect(formatDuration(START, after(hours(1)))).toBe('1h 00m');
    // The reported case: four hours, printed as four hours.
    expect(formatDuration(START, after(hours(4)))).toBe('4h 00m');
    expect(formatDuration(START, after(hours(4) + minutes(5)))).toBe('4h 05m');
    expect(formatDuration(START, after(hours(23) + minutes(59)))).toBe('23h 59m');
  });

  it('hands over again at a day, so the value stays two fields wide', () => {
    expect(formatDuration(START, after(hours(24)))).toBe('1d 00h');
    expect(formatDuration(START, after(hours(25)))).toBe('1d 01h');
    expect(formatDuration(START, after(hours(50)))).toBe('2d 02h');
  });

  it('reports an unknown start as unknown, and never counts backwards', () => {
    expect(formatDuration(null, after(hours(1)))).toBe('--');
    expect(formatDuration(undefined, undefined)).toBe('--');
    // A clock that disagrees with the server is not a negative duration.
    expect(formatDuration(after(hours(1)), START)).toBe('0m 00s');
  });
});

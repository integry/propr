import { describe, expect, it } from 'vitest';
import { keepIfEqual } from './keepIfEqual';

describe('keepIfEqual', () => {
  it('keeps the previous reference when the next value holds the same data', () => {
    const previous = { id: 'run-1', report: '# Report', steps: [{ name: 'report', done: true }] };
    const next = structuredClone(previous);
    expect(keepIfEqual(previous, next)).toBe(previous);
  });

  it('returns the next value when any part of the data changed', () => {
    const previous = { id: 'run-1', report: '# Report', steps: [{ name: 'report', done: true }] };
    const next = { ...previous, steps: [{ name: 'report', done: false }] };
    expect(keepIfEqual(previous, next)).toBe(next);
  });

  it('handles empty and missing values', () => {
    const empty: string[] = [];
    expect(keepIfEqual(empty, [])).toBe(empty);
    expect(keepIfEqual<string[] | null>(null, [])).toEqual([]);
    expect(keepIfEqual<string[] | undefined>(['a'], undefined)).toBeUndefined();
  });
});

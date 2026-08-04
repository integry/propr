import { describe, expect, it } from 'vitest';
import { formatToolResult } from './ExecutionEventUtils';

describe('formatToolResult', () => {
  it('falls back to String when JSON.stringify returns undefined', () => {
    expect(formatToolResult(Symbol('tool-result'))).toBe('Symbol(tool-result)');
  });

  it('falls back to String when JSON.stringify throws', () => {
    expect(formatToolResult(7n)).toBe('7');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatToolResult(cyclic)).toBe('[object Object]');
  });
});

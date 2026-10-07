import { describe, expect, it } from 'vitest';
import { formatTokenAmount } from './tokenFormat';

describe('formatTokenAmount', () => {
  it('uses a consistent compact unit for current and maximum token counts', () => {
    expect(formatTokenAmount(942_496)).toBe('942k');
    expect(formatTokenAmount(1_333_000)).toBe('1.33M');
    expect(formatTokenAmount(200_000)).toBe('200k');
    expect(formatTokenAmount(2_000_000)).toBe('2M');
    expect(formatTokenAmount(999_700)).toBe('1M');
    expect(formatTokenAmount(850)).toBe('850');
  });
});

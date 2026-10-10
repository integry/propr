import { describe, expect, it } from 'vitest';
import { humanizeMetricKey } from './usageMetricLabels';

describe('humanizeMetricKey', () => {
  it('maps known Agent Tank keys to their labels', () => {
    expect(humanizeMetricKey('weeklyAll')).toBe('Weekly');
    expect(humanizeMetricKey('fiveHour')).toBe('Five Hour');
  });

  it('keeps the provider prefix on Antigravity quota windows and drops "Remaining"', () => {
    expect(humanizeMetricKey('Gemini · Weekly Limit Remaining')).toBe('Gemini · Weekly Limit');
    expect(humanizeMetricKey('Gemini · Five Hour Limit Remaining')).toBe('Gemini · Five Hour Limit');
    expect(humanizeMetricKey('Claude and GPT · Weekly Limit Remaining')).toBe('Claude and GPT · Weekly Limit');
  });

  it('shortens keys that are actually Gemini models', () => {
    expect(humanizeMetricKey('gemini-2.5-flash')).toBe('2.5 Flash');
    expect(humanizeMetricKey('Gemini 2.5 Pro')).toBe('2.5 Pro');
  });

  it('splits unknown camelCase keys', () => {
    expect(humanizeMetricKey('weeklyCustom')).toBe('Weekly Custom');
  });
});

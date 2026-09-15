import { describe, expect, test } from 'vitest';
import { resolveSummaryBranch, summaryBrowserPath } from './summaryBrowser';

describe('summary browser branch resolution', () => {
  test('prefers an explicit branch, then the configured branch', () => {
    expect(resolveSummaryBranch('feature/explicit', 'main')).toBe('feature/explicit');
    expect(resolveSummaryBranch(undefined, 'release/2026')).toBe('release/2026');
  });

  test('preserves legacy fallback when neither branch is available', () => {
    expect(resolveSummaryBranch('', '  ')).toBeUndefined();
    expect(summaryBrowserPath('integry', 'propr')).toBe('/summaries/integry/propr');
  });

  test('URL-encodes branch names in standalone links', () => {
    expect(summaryBrowserPath('integry', 'propr', 'release/2026 Q1'))
      .toBe('/summaries/integry/propr?branch=release%2F2026%20Q1');
  });
});

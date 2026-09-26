import { describe, expect, test } from 'vitest';
import { resolveSummaryBranch, summaryBrowserPath, summaryHrefWithBranch } from './summaryBrowser';

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

  test('preserves Unicode whitespace that Git allows in branch names', () => {
    expect(resolveSummaryBranch('feature/a\u00a0', undefined)).toBe('feature/a\u00a0');
    expect(resolveSummaryBranch(undefined, '\tfeature/a\u00a0\n')).toBe('feature/a\u00a0');
    expect(summaryBrowserPath('integry', 'propr', 'feature/a\u00a0'))
      .toBe('/summaries/integry/propr?branch=feature%2Fa%C2%A0');
  });
});

describe('summary href branch preservation', () => {
  test('appends the branch to a branchless link to the repository summary page', () => {
    expect(summaryHrefWithBranch('/summaries/integry/propr', 'integry/propr', 'release/2026'))
      .toBe('/summaries/integry/propr?branch=release%2F2026');
  });

  test('keeps explicit branch queries and other parameters intact', () => {
    expect(summaryHrefWithBranch(
      '/summaries/integry/propr?branch=feature%2Fui',
      'integry/propr',
      'release/2026',
    )).toBe('/summaries/integry/propr?branch=feature%2Fui');
    expect(summaryHrefWithBranch('/summaries/integry/propr?path=src', 'integry/propr', 'release/2026'))
      .toBe('/summaries/integry/propr?path=src&branch=release%2F2026');
  });

  test('leaves links outside the repository summary page unchanged', () => {
    expect(summaryHrefWithBranch('/repositories', 'integry/propr', 'release/2026'))
      .toBe('/repositories');
    expect(summaryHrefWithBranch('/summaries/other/repo', 'integry/propr', 'release/2026'))
      .toBe('/summaries/other/repo');
  });
});

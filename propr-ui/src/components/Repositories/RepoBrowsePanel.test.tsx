import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import RepoBrowsePanel from './RepoBrowsePanel';

vi.mock('../SummaryBrowser', () => ({
  default: ({ owner, repo, branch }: { owner: string; repo: string; branch?: string }) => (
    <div data-testid="summary-browser">{`${owner}/${repo}:${branch ?? 'legacy'}`}</div>
  ),
}));

describe('RepoBrowsePanel', () => {
  test('passes the configured branch into repository Browse', () => {
    render(<RepoBrowsePanel owner="integry" repo="propr" branch="release/2026" />);
    expect(screen.getByTestId('summary-browser')).toHaveTextContent('integry/propr:release/2026');
  });
});

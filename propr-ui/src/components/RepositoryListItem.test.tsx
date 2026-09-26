import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RepositoryListItem } from './RepositoryListItem';
import type { MonitoredRepo, RepositoryIndexingStatus } from '../api/proprApi';

const repo: MonitoredRepo = {
  id: 'repo-1',
  name: 'integry/propr',
  enabled: true,
  baseBranch: 'feature/icons',
};

function status(overrides: Partial<RepositoryIndexingStatus> = {}): RepositoryIndexingStatus {
  return {
    full_name: repo.name,
    branch: repo.baseBranch!,
    indexing_status: 'completed',
    last_indexed_at: '2026-09-13T20:00:00.000Z',
    last_indexed_hash: '0123456789abcdef',
    last_indexed_commit_message: 'Add icon',
    icon_path: 'docs/static images/logo.svg',
    ...overrides,
  };
}

describe('RepositoryListItem', () => {
  it('renders the branch-specific discovered icon beside the repository name using the indexed hash', () => {
    render(
      <RepositoryListItem
        repo={repo}
        indexingStatuses={{ 'integry/propr:feature/icons': status() }}
        onSelect={vi.fn()}
      />,
    );

    const icon = screen.getByTestId('repository-icon-image');
    expect(icon).toHaveAttribute(
      'src',
      'https://raw.githubusercontent.com/integry/propr/0123456789abcdef/docs/static%20images/logo.svg',
    );
    expect(icon.nextElementSibling).toHaveAccessibleName('Select integry/propr');
  });

  it('uses the configured branch when no indexed hash exists and recovers to the GitHub fallback', () => {
    render(
      <RepositoryListItem
        repo={repo}
        indexingStatuses={{
          'integry/propr:feature/icons': status({ last_indexed_hash: null }),
        }}
      />,
    );

    const icon = screen.getByTestId('repository-icon-image');
    expect(icon).toHaveAttribute('src', expect.stringContaining('/feature%2Ficons/'));
    fireEvent.error(icon);
    expect(screen.getByTestId('repository-icon-fallback')).toBeInTheDocument();
  });
});

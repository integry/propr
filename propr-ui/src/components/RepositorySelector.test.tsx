import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RepositorySelector, RepoOption } from './RepositorySelector';

const mockRepos: RepoOption[] = [
  { name: 'org/repo-alpha', enabled: true, starred: true },
  { name: 'org/repo-beta', enabled: true },
  { name: 'org/repo-gamma', enabled: true },
  { name: 'other/repo-delta', enabled: true, starred: true },
  { name: 'other/repo-epsilon', enabled: true },
];

function renderSelector(props: Partial<Parameters<typeof RepositorySelector>[0]> = {}) {
  const defaultProps = {
    repos: mockRepos,
    selectedRepo: 'org/repo-alpha',
    onRepoChange: vi.fn(),
  };
  return render(<RepositorySelector {...defaultProps} {...props} />);
}

function openDropdown() {
  const trigger = screen.getByRole('button', { name: /repo-alpha|Select repository/i });
  fireEvent.click(trigger);
}

function getVisibleRepoButtons() {
  return screen.getAllByRole('button').filter(btn => {
    // RepoItem buttons have the w-full and text-left classes
    return btn.className.includes('text-left') && btn.className.includes('w-full');
  });
}

describe('RepositorySelector', () => {
  it('renders without crashing', () => {
    renderSelector();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('shows all repos when dropdown is opened', () => {
    renderSelector();
    openDropdown();
    const items = getVisibleRepoButtons();
    expect(items).toHaveLength(mockRepos.length);
  });

  it('filters repos by name', () => {
    renderSelector();
    openDropdown();
    const input = screen.getByPlaceholderText('Filter repositories...');
    fireEvent.change(input, { target: { value: 'alpha' } });
    const items = getVisibleRepoButtons();
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('repo-alpha');
  });

  // Regression: repeated filtering must not multiply dropdown items
  it('does not multiply items after repeated filter changes', () => {
    renderSelector();
    openDropdown();
    const input = screen.getByPlaceholderText('Filter repositories...');

    // Cycle through several filter values
    const filterSequence = ['org', '', 'repo', '', 'alpha', '', 'beta', '', 'org', ''];
    for (const value of filterSequence) {
      fireEvent.change(input, { target: { value } });
    }

    // After clearing the filter, we should see exactly the original count
    const items = getVisibleRepoButtons();
    expect(items).toHaveLength(mockRepos.length);
  });

  // Regression: opening and closing dropdown repeatedly must not multiply items
  it('does not multiply items after repeated open/close cycles', () => {
    renderSelector();

    for (let i = 0; i < 5; i++) {
      openDropdown();
      // Close by clicking outside or pressing Escape
      fireEvent.keyDown(screen.getByPlaceholderText('Filter repositories...'), { key: 'Escape' });
    }

    openDropdown();
    const items = getVisibleRepoButtons();
    expect(items).toHaveLength(mockRepos.length);
  });

  // Regression: filtering after open/close cycles must not multiply items
  it('does not multiply items when combining open/close and filtering', () => {
    renderSelector();

    // Open, filter, close, repeat
    for (let i = 0; i < 3; i++) {
      openDropdown();
      const input = screen.getByPlaceholderText('Filter repositories...');
      fireEvent.change(input, { target: { value: 'org' } });
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.keyDown(input, { key: 'Escape' });
    }

    openDropdown();
    const items = getVisibleRepoButtons();
    expect(items).toHaveLength(mockRepos.length);
  });

  it('calls onRepoChange when a repo is selected', () => {
    const onRepoChange = vi.fn();
    renderSelector({ onRepoChange });
    openDropdown();

    const items = getVisibleRepoButtons();
    const betaItem = items.find(btn => btn.textContent?.includes('repo-beta'));
    expect(betaItem).toBeDefined();
    fireEvent.click(betaItem!);

    expect(onRepoChange).toHaveBeenCalledWith('org/repo-beta');
  });

  it('shows starred repos in a separate section', () => {
    renderSelector();
    openDropdown();
    expect(screen.getByText('Starred')).toBeInTheDocument();
  });

  it('shows "No repositories found" for filter with no matches', () => {
    renderSelector();
    openDropdown();
    const input = screen.getByPlaceholderText('Filter repositories...');
    fireEvent.change(input, { target: { value: 'nonexistent-xyz' } });
    expect(screen.getByText('No repositories found')).toBeInTheDocument();
  });
});

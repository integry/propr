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

  // Regression: duplicate repos in input must be deduplicated in display
  it('deduplicates repos with the same name', () => {
    const duplicateRepos: RepoOption[] = [
      { name: 'integry/forex', enabled: true, starred: true },
      { name: 'integry/forex', enabled: true, starred: false },
      { name: 'integry/forex', enabled: true, baseBranch: 'develop' },
      { name: 'org/other-repo', enabled: true },
    ];
    const { container } = render(
      <RepositorySelector repos={duplicateRepos} selectedRepo="integry/forex" onRepoChange={vi.fn()} />
    );
    // Click the trigger button (first button in the container)
    const trigger = container.querySelector('button')!;
    fireEvent.click(trigger);
    const items = getVisibleRepoButtons();
    // Should show exactly 2 unique repos, not 4
    expect(items).toHaveLength(2);
  });

  // Regression: duplicate repos must stay deduplicated after repeated filtering
  it('does not multiply duplicate repos after repeated filtering', () => {
    const duplicateRepos: RepoOption[] = [
      { name: 'integry/forex', enabled: true, starred: true },
      { name: 'integry/forex', enabled: true },
      { name: 'integry/forex', enabled: true },
      { name: 'integry/propr', enabled: true },
      { name: 'integry/propr', enabled: true },
    ];
    const { container } = render(
      <RepositorySelector repos={duplicateRepos} selectedRepo="integry/forex" onRepoChange={vi.fn()} />
    );
    const trigger = container.querySelector('button')!;
    fireEvent.click(trigger);
    const input = screen.getByPlaceholderText('Filter repositories...');

    // Rapidly filter and clear multiple times
    for (let i = 0; i < 10; i++) {
      fireEvent.change(input, { target: { value: 'forex' } });
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.change(input, { target: { value: 'integry' } });
      fireEvent.change(input, { target: { value: '' } });
    }

    const items = getVisibleRepoButtons();
    // Should show exactly 2 unique repos regardless of duplicates in input
    expect(items).toHaveLength(2);
  });

  it('clears filter when closing via trigger button', () => {
    const { container } = render(
      <RepositorySelector repos={mockRepos} selectedRepo="org/repo-alpha" onRepoChange={vi.fn()} />
    );
    const trigger = container.querySelector('button')!;
    fireEvent.click(trigger);
    const input = screen.getByPlaceholderText('Filter repositories...');
    fireEvent.change(input, { target: { value: 'alpha' } });
    expect(getVisibleRepoButtons()).toHaveLength(1);

    // Close via trigger button click
    fireEvent.click(trigger);

    // Reopen - filter should be cleared, showing all repos
    fireEvent.click(trigger);
    const items = getVisibleRepoButtons();
    expect(items).toHaveLength(mockRepos.length);
  });
});

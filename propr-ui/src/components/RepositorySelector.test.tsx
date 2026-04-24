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

  // Regression: repos with same name but different branches must be preserved
  it('preserves repos with same name but different baseBranch', () => {
    const branchRepos: RepoOption[] = [
      { name: 'integry/forex', enabled: true, baseBranch: 'main' },
      { name: 'integry/forex', enabled: true, baseBranch: 'develop' },
      { name: 'org/other-repo', enabled: true },
    ];
    const { container } = render(
      <RepositorySelector repos={branchRepos} selectedRepo="integry/forex" onRepoChange={vi.fn()} />
    );
    const trigger = container.querySelector('button')!;
    fireEvent.click(trigger);
    const items = getVisibleRepoButtons();
    // All 3 entries should be shown (2 forex with different branches + 1 other)
    expect(items).toHaveLength(3);
  });

  // Regression: branch-specific repos must survive repeated filtering
  it('does not lose or multiply branch-specific repos after repeated filtering', () => {
    const branchRepos: RepoOption[] = [
      { name: 'integry/forex', enabled: true, baseBranch: 'main', starred: true },
      { name: 'integry/forex', enabled: true, baseBranch: 'develop' },
      { name: 'integry/propr', enabled: true },
    ];
    const { container } = render(
      <RepositorySelector repos={branchRepos} selectedRepo="integry/forex" onRepoChange={vi.fn()} />
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
    // Should show all 3 entries (2 forex branches + 1 propr)
    expect(items).toHaveLength(3);
  });

  // Regression: filtering should correctly filter branch-specific entries by name
  it('filters all branch variants of a repo by name', () => {
    const branchRepos: RepoOption[] = [
      { name: 'integry/forex', enabled: true, baseBranch: 'main' },
      { name: 'integry/forex', enabled: true, baseBranch: 'develop' },
      { name: 'integry/propr', enabled: true },
    ];
    const { container } = render(
      <RepositorySelector repos={branchRepos} selectedRepo="integry/forex" onRepoChange={vi.fn()} />
    );
    const trigger = container.querySelector('button')!;
    fireEvent.click(trigger);
    const input = screen.getByPlaceholderText('Filter repositories...');

    fireEvent.change(input, { target: { value: 'forex' } });
    const items = getVisibleRepoButtons();
    // Both forex entries (main and develop) should appear
    expect(items).toHaveLength(2);
  });

  it('renders custom displayName instead of repo name', () => {
    const repos: RepoOption[] = [
      { name: 'org/repo-alpha', enabled: true, displayName: 'All Repos' },
      { name: 'org/repo-beta', enabled: true },
    ];
    render(
      <RepositorySelector repos={repos} selectedRepo="org/repo-alpha" onRepoChange={vi.fn()} />
    );
    // Trigger should show custom label
    expect(screen.getByRole('button').textContent).toContain('All Repos');

    // Open dropdown and verify item label
    fireEvent.click(screen.getByRole('button'));
    const items = getVisibleRepoButtons();
    expect(items[0].textContent).toContain('All Repos');
    // The second repo without displayName should still show normal name
    expect(items[1].textContent).toContain('repo-beta');
  });

  it('renders count badges when count is provided', () => {
    const repos: RepoOption[] = [
      { name: 'org/repo-alpha', enabled: true, displayName: 'All Repos', count: 42 },
      { name: 'org/repo-beta', enabled: true, count: 7 },
      { name: 'org/repo-gamma', enabled: true },
    ];
    render(
      <RepositorySelector repos={repos} selectedRepo="org/repo-alpha" onRepoChange={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button'));
    const items = getVisibleRepoButtons();
    expect(items[0].textContent).toContain('42');
    expect(items[1].textContent).toContain('7');
    // Third item has no count
    expect(items[2].textContent).not.toContain('42');
    expect(items[2].textContent).not.toContain('7');
  });

  it('filters by repo name even when displayName differs', () => {
    const repos: RepoOption[] = [
      { name: 'org/repo-alpha', enabled: true, displayName: 'All Repos', count: 10 },
      { name: 'org/repo-beta', enabled: true, count: 5 },
    ];
    render(
      <RepositorySelector repos={repos} selectedRepo="org/repo-alpha" onRepoChange={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button'));
    const input = screen.getByPlaceholderText('Filter repositories...');

    // Filter by the underlying repo name should still find "All Repos"
    fireEvent.change(input, { target: { value: 'alpha' } });
    let items = getVisibleRepoButtons();
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('All Repos');

    // Filter by displayName should also work
    fireEvent.change(input, { target: { value: 'All Repos' } });
    items = getVisibleRepoButtons();
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('All Repos');
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

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Filters } from './Filters';

vi.mock('../../utils/repoHelpers', () => ({ fetchEnabledRepos: vi.fn().mockResolvedValue([]) }));

const props = {
  filter: 'all', setFilter: vi.fn(), setRepoFilter: vi.fn(), reposLoading: false, searchQuery: '', setSearchQuery: vi.fn(),
  assigneeFilter: 'all', setAssigneeFilter: vi.fn(), canFilterToMe: true,
  assigneeOptions: [{ value: 'hubot', login: 'hubot' }, { value: 'octocat', login: 'octocat' }],
  availableRepos: [
    { name: 'all', enabled: true, displayName: 'All Repos', count: 14768 },
    { name: 'integry/propr', enabled: true, count: 14767 },
    { name: 'integry/desktop', enabled: true, count: 1 },
  ],
};

describe('Filters', () => {
  it('shows the selected repository in the stacked owner-over-name format', () => {
    render(<MemoryRouter><Filters {...props} repoFilter="integry/propr" /></MemoryRouter>);
    const trigger = screen.getByRole('button', { name: /propr/ });
    expect(within(trigger).getByText('integry')).toHaveClass('text-[10px]');
    expect(within(trigger).getByText('propr')).toHaveClass('font-medium');
  });

  it('lists All Repos first, above starred repositories, in a menu wide enough for long names', () => {
    const availableRepos = [
      { name: 'integry/propr', enabled: true, count: 14767, starred: true },
      { name: 'all', enabled: true, displayName: 'All Repos', count: 14768 },
      { name: 'integry/desktop', enabled: true, count: 1 },
    ];
    render(<MemoryRouter><Filters {...props} availableRepos={availableRepos} repoFilter="integry/propr" /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /propr/ }));
    const rows = screen.getAllByTestId('repo-item');
    expect(rows.map(row => row.getAttribute('data-repository-name'))).toEqual(['all', 'integry/propr', 'integry/desktop']);
    expect(rows[0].closest('.absolute')).toHaveClass('min-w-[min(20rem,calc(100vw-1rem))]');
  });

  it('leaves the filter dropdowns to do the filtering, with no separate filter icon', () => {
    const { container } = render(<MemoryRouter><Filters {...props} repoFilter="all" /></MemoryRouter>);
    expect(container.querySelector('.lucide-filter, .lucide-funnel')).toBeNull();
  });

  it('offers everyone, me, nobody and the people on the page, and reports the choice', () => {
    const setAssigneeFilter = vi.fn();
    render(<MemoryRouter><Filters {...props} repoFilter="all" setAssigneeFilter={setAssigneeFilter} /></MemoryRouter>);
    const select = screen.getByRole('combobox', { name: 'Assignee' });
    expect(within(select).getAllByRole('option').map(option => option.textContent))
      .toEqual(['All assignees', 'Assigned to me', 'Unassigned', '@hubot', '@octocat']);
    fireEvent.change(select, { target: { value: 'octocat' } });
    expect(setAssigneeFilter).toHaveBeenCalledWith('octocat');
  });

  it('offers only All and Unassigned without a signed-in user', () => {
    render(<MemoryRouter><Filters {...props} repoFilter="all" canFilterToMe={false} assigneeOptions={[]} /></MemoryRouter>);
    const select = screen.getByRole('combobox', { name: 'Assignee' });
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['All assignees', 'Unassigned']);
  });

  it('keeps a login from the URL selected when the page does not list it', () => {
    render(<MemoryRouter><Filters {...props} repoFilter="all" assigneeFilter="monalisa" /></MemoryRouter>);
    expect(screen.getByRole('combobox', { name: 'Assignee' })).toHaveDisplayValue('@monalisa');
  });

  it('draws no assignee filter on the dashboard widget', () => {
    render(<MemoryRouter><Filters {...props} repoFilter="all" hideFilters showViewAll /></MemoryRouter>);
    expect(screen.queryByRole('combobox', { name: 'Assignee' })).toBeNull();
  });
});

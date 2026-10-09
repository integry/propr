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
  it('names the selected repository without its owner', () => {
    render(<MemoryRouter><Filters {...props} repoFilter="integry/propr" /></MemoryRouter>);
    const trigger = screen.getByRole('button', { name: /propr/ });
    expect(trigger).toHaveTextContent('propr');
    expect(trigger).not.toHaveTextContent('integry/');
  });

  it('keeps the owner when two owners share a repository name', () => {
    const availableRepos = [...props.availableRepos, { name: 'acme/propr', enabled: true, count: 3 }];
    render(<MemoryRouter><Filters {...props} availableRepos={availableRepos} repoFilter="integry/propr" /></MemoryRouter>);
    expect(screen.getByRole('button', { name: /propr/ })).toHaveTextContent('integry/propr');
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

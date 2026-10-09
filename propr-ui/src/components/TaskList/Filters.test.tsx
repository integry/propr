import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Filters } from './Filters';

vi.mock('../../utils/repoHelpers', () => ({ fetchEnabledRepos: vi.fn().mockResolvedValue([]) }));

const props = {
  filter: 'all', setFilter: vi.fn(), setRepoFilter: vi.fn(), reposLoading: false, searchQuery: '', setSearchQuery: vi.fn(),
  assigneeFilter: 'all', setAssigneeFilter: vi.fn(), canFilterToMe: true,
  assigneePeople: ['hubot', 'octocat'],
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

  const openAssignee = () => {
    fireEvent.click(screen.getByRole('button', { name: /^Assignee:/ }));
    return screen.getByRole('dialog', { name: 'Filter by assignee' });
  };
  const people = (dialog: HTMLElement) => within(within(dialog).getByRole('group', { name: 'People' })).queryAllByRole('checkbox');

  it('offers everyone, me, nobody and the people seen, and reports a single choice', () => {
    const setAssigneeFilter = vi.fn();
    render(<MemoryRouter><Filters {...props} repoFilter="all" setAssigneeFilter={setAssigneeFilter} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Assignee: All assignees' })).toBeInTheDocument();
    const dialog = openAssignee();
    expect(within(dialog).getAllByRole('radio').map(radio => radio.parentElement!.textContent)).toEqual(['All assignees', 'Assigned to me', 'Unassigned']);
    expect(people(dialog).map(box => box.parentElement!.textContent)).toEqual(['@hubot', '@octocat']);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Assigned to me' }));
    expect(setAssigneeFilter).toHaveBeenCalledWith('me');
    // A single choice closes the popover, as a select would.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('adds a second person to the selection instead of replacing the first', () => {
    const setAssigneeFilter = vi.fn();
    render(<MemoryRouter><Filters {...props} repoFilter="all" assigneeFilter="hubot" setAssigneeFilter={setAssigneeFilter} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Assignee: @hubot' })).toBeInTheDocument();
    const dialog = openAssignee();
    expect(people(dialog).map(box => (box as HTMLInputElement).checked)).toEqual([true, false]);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '@octocat' }));
    expect(setAssigneeFilter).toHaveBeenLastCalledWith('hubot,octocat');
    // Stays open for more people.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('names a multi-person filter by its first login and how many more, and unticks one', () => {
    const setAssigneeFilter = vi.fn();
    render(<MemoryRouter><Filters {...props} repoFilter="all" assigneeFilter="hubot,octocat" setAssigneeFilter={setAssigneeFilter} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Assignee: @hubot +1' })).toBeInTheDocument();
    const dialog = openAssignee();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '@hubot' }));
    expect(setAssigneeFilter).toHaveBeenLastCalledWith('octocat');
  });

  it('unticking the last person goes back to all assignees', () => {
    const setAssigneeFilter = vi.fn();
    render(<MemoryRouter><Filters {...props} repoFilter="all" assigneeFilter="hubot" setAssigneeFilter={setAssigneeFilter} /></MemoryRouter>);
    fireEvent.click(within(openAssignee()).getByRole('checkbox', { name: '@hubot' }));
    expect(setAssigneeFilter).toHaveBeenLastCalledWith('all');
  });

  it('adds a login nobody on the page is assigned to, and refuses an invalid one', () => {
    const setAssigneeFilter = vi.fn();
    render(<MemoryRouter><Filters {...props} repoFilter="all" assigneeFilter="hubot" setAssigneeFilter={setAssigneeFilter} /></MemoryRouter>);
    const dialog = openAssignee();
    const field = within(dialog).getByRole('searchbox', { name: 'Find or add a GitHub login' });
    fireEvent.change(field, { target: { value: '@monalisa' } });
    expect(people(dialog)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add @monalisa' }));
    expect(setAssigneeFilter).toHaveBeenLastCalledWith('hubot,monalisa');

    fireEvent.change(field, { target: { value: 'not a login' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('@not a login is not a valid GitHub login.');
    expect(setAssigneeFilter).toHaveBeenCalledTimes(1);
  });

  it('stops adding people at the filter\'s limit without calling a valid login invalid', () => {
    const setAssigneeFilter = vi.fn();
    const twenty = Array.from({ length: 20 }, (_, index) => `user${index}`);
    render(<MemoryRouter><Filters {...props} repoFilter="all" assigneeFilter={twenty.join(',')} setAssigneeFilter={setAssigneeFilter} /></MemoryRouter>);
    const dialog = openAssignee();
    expect(within(dialog).getByText('The filter can name at most 20 people.')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: '@hubot' })).toBeDisabled();
    const field = within(dialog).getByRole('searchbox', { name: 'Find or add a GitHub login' });
    fireEvent.change(field, { target: { value: 'monalisa' } });
    expect(within(dialog).queryByRole('button', { name: 'Add @monalisa' })).toBeNull();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(setAssigneeFilter).not.toHaveBeenCalled();
  });

  it('Enter in the field ticks a listed person it matches exactly', () => {
    const setAssigneeFilter = vi.fn();
    render(<MemoryRouter><Filters {...props} repoFilter="all" setAssigneeFilter={setAssigneeFilter} /></MemoryRouter>);
    const field = within(openAssignee()).getByRole('searchbox', { name: 'Find or add a GitHub login' });
    fireEvent.change(field, { target: { value: 'OCTOCAT' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(setAssigneeFilter).toHaveBeenLastCalledWith('octocat');
  });

  it('keeps a login that reads as a keyword or a default distinct from it', () => {
    const setAssigneeFilter = vi.fn();
    render(<MemoryRouter><Filters {...props} repoFilter="all" assigneePeople={['all', '1']} setAssigneeFilter={setAssigneeFilter} /></MemoryRouter>);
    const dialog = openAssignee();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '@all' }));
    expect(setAssigneeFilter).toHaveBeenLastCalledWith('@all');
    // `1` is a value the URL drops as a default, so it keeps its `@` too.
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '@1' }));
    expect(setAssigneeFilter).toHaveBeenLastCalledWith('@1');
  });

  it('offers only All and Unassigned without a signed-in user', () => {
    render(<MemoryRouter><Filters {...props} repoFilter="all" canFilterToMe={false} assigneePeople={[]} /></MemoryRouter>);
    const dialog = openAssignee();
    expect(within(dialog).getAllByRole('radio').map(radio => radio.parentElement!.textContent)).toEqual(['All assignees', 'Unassigned']);
    expect(people(dialog)).toHaveLength(0);
  });

  it('keeps logins from the URL ticked when the page does not list them', () => {
    render(<MemoryRouter><Filters {...props} repoFilter="all" assigneeFilter="monalisa,defunkt" /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Assignee: @monalisa +1' })).toBeInTheDocument();
    const dialog = openAssignee();
    expect(within(dialog).getByRole('checkbox', { name: '@monalisa' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: '@defunkt' })).toBeChecked();
  });

  it('closes on Escape and hands focus back to the trigger', () => {
    render(<MemoryRouter><Filters {...props} repoFilter="all" /></MemoryRouter>);
    const dialog = openAssignee();
    fireEvent.keyDown(within(dialog).getByRole('searchbox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /^Assignee:/ })).toHaveFocus();
  });

  it('draws no assignee filter on the dashboard widget', () => {
    render(<MemoryRouter><Filters {...props} repoFilter="all" hideFilters showViewAll /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /^Assignee:/ })).toBeNull();
  });
});

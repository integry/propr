import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Filters } from './Filters';

vi.mock('../../utils/repoHelpers', () => ({ fetchEnabledRepos: vi.fn().mockResolvedValue([]) }));

const props = {
  filter: 'all', setFilter: vi.fn(), setRepoFilter: vi.fn(), reposLoading: false, searchQuery: '', setSearchQuery: vi.fn(),
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
});

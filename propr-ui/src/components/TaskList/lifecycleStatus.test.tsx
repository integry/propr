import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Filters } from './Filters';
import { getStatusPill } from './utils.tsx';

const filterProps = {
  filter: 'all',
  setFilter: vi.fn(),
  repoFilter: 'all',
  setRepoFilter: vi.fn(),
  availableRepos: [],
  reposLoading: false,
  searchQuery: '',
  setSearchQuery: vi.fn(),
};

const renderFilters = (filter: string) => render(
  <MemoryRouter><Filters {...filterProps} filter={filter} /></MemoryRouter>
);

describe('lifecycle status presentation', () => {
  it.each(['active', 'implementing', 'processing', 'claude_execution', 'post_processing'])(
    'renders the Implementing badge for the %s worker state',
    status => {
      render(<>{getStatusPill(status)}</>);
      const pill = screen.getByText('Implementing');
      expect(pill).toBeInTheDocument();
      expect(pill.className).toContain('bg-teal-50');
      expect(pill.querySelector('.animate-pulse')).not.toBeNull();
    }
  );

  it.each(['waiting', 'pending', 'queued'])('renders the Pending badge for the %s queue state', status => {
    render(<>{getStatusPill(status)}</>);
    expect(screen.getByText('Pending').className).toContain('bg-purple-50');
  });

  it.each([
    ['active', 'active'],
    ['implementing', 'active'],
    ['waiting', 'waiting'],
    ['pending', 'waiting'],
    ['completed', 'completed'],
    ['all', 'all'],
  ])('binds the status dropdown to %s as the %s option', (filter, expected) => {
    renderFilters(filter);
    expect(screen.getByRole('combobox')).toHaveValue(expected);
  });
});

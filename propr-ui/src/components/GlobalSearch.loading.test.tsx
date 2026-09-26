import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDrafts } from '../api/plannerApi';
import { getInstanceCatalog, getTasks } from '../api/proprApi';
import GlobalSearch from './GlobalSearch';

vi.mock('../api/plannerApi', () => ({ getDrafts: vi.fn() }));
vi.mock('../api/proprApi', () => ({ getInstanceCatalog: vi.fn(), getTasks: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('GlobalSearch loading states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getInstanceCatalog).mockResolvedValue({ agents: [], repositories: [] });
  });

  it('waits for successful task and plan reads before showing no results', async () => {
    const plans = deferred<Awaited<ReturnType<typeof getDrafts>>>();
    const tasks = deferred<Awaited<ReturnType<typeof getTasks>>>();
    vi.mocked(getDrafts).mockReturnValue(plans.promise);
    vi.mocked(getTasks).mockReturnValue(tasks.promise);

    render(<MemoryRouter><GlobalSearch /></MemoryRouter>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: 'missing' } });

    expect(screen.getByText('Searching...')).toBeInTheDocument();
    expect(screen.queryByText(/No results found/)).not.toBeInTheDocument();
    await waitFor(() => expect(getTasks).toHaveBeenCalledTimes(1));

    await act(async () => {
      plans.resolve({ drafts: [], total: 0, page: 1, limit: 5, hasMore: false });
      tasks.resolve({ tasks: [], total: 0 });
    });

    expect(await screen.findByText('No results found for "missing"')).toBeInTheDocument();
  });

  it('renders a search failure as an error rather than an empty result', async () => {
    vi.mocked(getDrafts).mockRejectedValue(new Error('Search unavailable'));
    vi.mocked(getTasks).mockResolvedValue({ tasks: [], total: 0 });

    render(<MemoryRouter><GlobalSearch /></MemoryRouter>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: 'broken' } });
    await waitFor(() => expect(getTasks).toHaveBeenCalledTimes(1));

    expect(await screen.findByRole('alert')).toHaveTextContent('Search unavailable');
    expect(screen.queryByText(/No results found/)).not.toBeInTheDocument();
  });
});

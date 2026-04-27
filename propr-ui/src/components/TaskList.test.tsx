import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TaskList from './TaskList';
import { getTasks, getRepositoryStats } from '../api/proprApi';

const mockGetTasks = vi.mocked(getTasks);
const mockGetRepositoryStats = vi.mocked(getRepositoryStats);

let taskUpdateHandler: (() => void) | null = null;

vi.mock('../api/proprApi', () => ({
  getTasks: vi.fn(),
  getRepositoryStats: vi.fn(),
}));

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: true,
    onTaskUpdate: (handler: () => void) => {
      taskUpdateHandler = handler;
      return () => {
        if (taskUpdateHandler === handler) taskUpdateHandler = null;
      };
    },
  }),
}));

vi.mock('./TaskList/Filters', () => ({
  Filters: ({ availableRepos, reposLoading }: { availableRepos: Array<{ name: string; count?: number }>; reposLoading: boolean }) => (
    <div data-testid="filters">
      <span data-testid="repos-loading">{String(reposLoading)}</span>
      <span data-testid="repo-summary">{availableRepos.map(repo => `${repo.name}:${repo.count ?? 'na'}`).join('|')}</span>
    </div>
  ),
}));

vi.mock('./TaskList/Pagination', () => ({
  Pagination: () => null,
}));

vi.mock('./TaskList/StateComponents', () => ({
  DashboardLoadingState: () => <div>dashboard loading</div>,
  FullPageLoadingState: () => <div>page loading</div>,
  DashboardErrorState: ({ error }: { error: string }) => <div>{error}</div>,
  FullPageErrorState: ({ error }: { error: string }) => <div>{error}</div>,
  TaskTableContent: () => <div>task table</div>,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TaskList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskUpdateHandler = null;
  });

  it('keeps the repository filter visible in a loading state while stats are loading', async () => {
    const statsRequest = deferred<{ repositories: Array<{ repository: string; total: number }> }>();
    mockGetTasks.mockResolvedValue({ tasks: [], total: 0 });
    mockGetRepositoryStats.mockReturnValue(statsRequest.promise);

    render(
      <MemoryRouter>
        <TaskList limit={10} />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId('filters')).toBeInTheDocument());
    expect(screen.getByTestId('repos-loading').textContent).toBe('true');

    await act(async () => {
      statsRequest.resolve({ repositories: [{ repository: 'integry/propr', total: 3 }] });
      await statsRequest.promise;
    });

    await waitFor(() => expect(screen.getByTestId('repos-loading').textContent).toBe('false'));
    expect(screen.getByTestId('repo-summary').textContent).toBe('all:3|integry/propr:3');
  });

  it('refreshes repository stats when live task updates arrive', async () => {
    mockGetTasks.mockResolvedValue({ tasks: [], total: 0 });
    mockGetRepositoryStats
      .mockResolvedValueOnce({ repositories: [{ repository: 'integry/propr', total: 1 }] })
      .mockResolvedValueOnce({ repositories: [{ repository: 'integry/propr', total: 2 }] });

    render(
      <MemoryRouter>
        <TaskList limit={10} />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId('repo-summary').textContent).toBe('all:1|integry/propr:1'));
    expect(taskUpdateHandler).not.toBeNull();

    await act(async () => {
      taskUpdateHandler?.();
    });

    await waitFor(() => expect(mockGetRepositoryStats).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('repo-summary').textContent).toBe('all:2|integry/propr:2'));
  });
});

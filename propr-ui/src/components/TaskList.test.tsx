import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import TaskList from './TaskList';
import { getTasks, getRepositoryStats } from '../api/proprApi';
import type { TaskUpdatePayload } from '@propr/shared';

const mockGetTasks = vi.mocked(getTasks);
const mockGetRepositoryStats = vi.mocked(getRepositoryStats);

const repositoryStats = (repository: string, total: number) => ({
  repository,
  total,
  completed: 0,
  failed: 0,
  inProgress: 0,
  successRate: 0,
});

const populatedTaskResponse = (): Awaited<ReturnType<typeof getTasks>> => ({
  tasks: [{ id: 'task-1', repository: 'integry/propr', status: 'processing', createdAt: '2026-09-14T00:00:00Z' }],
  total: 1,
} as unknown as Awaited<ReturnType<typeof getTasks>>);

let taskUpdateHandler: ((payload: TaskUpdatePayload) => void) | null = null;

vi.mock('../api/proprApi', () => ({
  getTasks: vi.fn(),
  getRepositoryStats: vi.fn(),
}));

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: true,
    onTaskUpdate: (handler: (payload: TaskUpdatePayload) => void) => {
      taskUpdateHandler = handler;
      return () => {
        if (taskUpdateHandler === handler) taskUpdateHandler = null;
      };
    },
  }),
}));

vi.mock('./TaskList/Filters', () => ({
  Filters: ({ availableRepos, reposLoading, filter, setFilter }: {
    availableRepos: Array<{ name: string; count?: number }>;
    reposLoading: boolean;
    filter: string;
    setFilter: (value: string) => void;
  }) => (
    <div data-testid="filters">
      <span data-testid="repos-loading">{String(reposLoading)}</span>
      <span data-testid="repo-summary">{availableRepos.map(repo => `${repo.name}:${repo.count ?? 'na'}`).join('|')}</span>
      <select data-testid="status-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="all">All Tasks</option>
        <option value="active">Active</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
        <option value="waiting">Waiting</option>
      </select>
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

const NavigationHarness = () => {
  const navigate = useNavigate();

  return (
    <>
      <button type="button" onClick={() => navigate('/tasks?status=completed')}>
        change filters
      </button>
      <TaskList limit={10} />
    </>
  );
};

describe('TaskList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskUpdateHandler = null;
  });

  it('keeps the repository filter visible in a loading state while stats are loading', async () => {
    const statsRequest = deferred<Awaited<ReturnType<typeof getRepositoryStats>>>();
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
      statsRequest.resolve({ repositories: [repositoryStats('integry/propr', 3)] });
      await statsRequest.promise;
    });

    await waitFor(() => expect(screen.getByTestId('repos-loading').textContent).toBe('false'));
    expect(screen.getByTestId('repo-summary').textContent).toBe('all:3|integry/propr:3');
  });

  it('refreshes repository stats when live task updates arrive', async () => {
    mockGetTasks.mockResolvedValue({ tasks: [], total: 0 });
    mockGetRepositoryStats
      .mockResolvedValueOnce({ repositories: [repositoryStats('integry/propr', 1)] })
      .mockResolvedValueOnce({ repositories: [repositoryStats('integry/propr', 2)] });

    render(
      <MemoryRouter>
        <TaskList limit={10} />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByTestId('repo-summary').textContent).toBe('all:1|integry/propr:1'));
    expect(taskUpdateHandler).not.toBeNull();

    await act(async () => {
      taskUpdateHandler?.({
        eventType: 'task:update', taskId: 'task-1', state: 'completed',
        previousState: 'processing', repository: 'integry/propr', issueNumber: 1,
        timestamp: '2026-09-13T00:00:00.000Z',
      });
    });

    await waitFor(() => expect(mockGetRepositoryStats).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('repo-summary').textContent).toBe('all:2|integry/propr:2'));
  });

  it('does not refetch repository stats when task query params change', async () => {
    mockGetTasks.mockResolvedValue({ tasks: [], total: 0 });
    mockGetRepositoryStats.mockResolvedValue({ repositories: [repositoryStats('integry/propr', 1)] });

    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes>
          <Route path="/tasks" element={<NavigationHarness />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(mockGetRepositoryStats).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockGetTasks).toHaveBeenCalledTimes(1));

    await act(async () => {
      screen.getByRole('button', { name: 'change filters' }).click();
    });

    await waitFor(() => expect(mockGetTasks).toHaveBeenCalledTimes(2));
    expect(mockGetRepositoryStats).toHaveBeenCalledTimes(1);
  });

  it('shows loading until an initial empty read succeeds and never treats a failure as empty', async () => {
    const taskRequest = deferred<Awaited<ReturnType<typeof getTasks>>>();
    mockGetTasks.mockReturnValue(taskRequest.promise);
    mockGetRepositoryStats.mockResolvedValue({ repositories: [] });

    const view = render(<MemoryRouter><TaskList limit={10} /></MemoryRouter>);

    expect(screen.getByText('page loading')).toBeInTheDocument();
    expect(screen.queryByText(/No tasks found/)).not.toBeInTheDocument();

    await act(async () => { taskRequest.resolve({ tasks: [], total: 0 }); });
    expect(await screen.findByText(/No tasks found/)).toBeInTheDocument();

    view.unmount();
    const failedRequest = deferred<Awaited<ReturnType<typeof getTasks>>>();
    mockGetTasks.mockReturnValue(failedRequest.promise);
    render(<MemoryRouter><TaskList limit={10} /></MemoryRouter>);
    await act(async () => { failedRequest.reject(new Error('Tasks unavailable')); });

    expect(await screen.findByText('Tasks unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/No tasks found/)).not.toBeInTheDocument();
  });

  it('does not expose rows from the previous filter while the next scope is pending', async () => {
    const nextScope = deferred<Awaited<ReturnType<typeof getTasks>>>();
    mockGetTasks
      .mockResolvedValueOnce(populatedTaskResponse())
      .mockReturnValueOnce(nextScope.promise);
    mockGetRepositoryStats.mockResolvedValue({ repositories: [] });

    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes><Route path="/tasks" element={<NavigationHarness />} /></Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText('task table')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'change filters' }));
    expect(await screen.findByText('page loading')).toBeInTheDocument();
    expect(screen.queryByText('task table')).not.toBeInTheDocument();
    expect(screen.queryByText(/No tasks found/)).not.toBeInTheDocument();

    await act(async () => { nextScope.resolve({ tasks: [], total: 0 }); });
    expect(await screen.findByText(/No tasks found/)).toBeInTheDocument();
  });

  it('requests and renders active tasks when the status filter is active', async () => {
    mockGetTasks.mockResolvedValue(populatedTaskResponse());
    mockGetRepositoryStats.mockResolvedValue({ repositories: [repositoryStats('integry/propr', 1)] });

    render(
      <MemoryRouter initialEntries={['/tasks?status=active']}>
        <Routes><Route path="/tasks" element={<TaskList limit={10} />} /></Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText('task table')).toBeInTheDocument();
    expect(screen.queryByText(/No tasks found/)).not.toBeInTheDocument();
    expect(mockGetTasks).toHaveBeenCalledWith('active', 20, 0, 'all', '');
  });

  it('requests active tasks when Active is selected in the filter dropdown', async () => {
    mockGetTasks.mockResolvedValue(populatedTaskResponse());
    mockGetRepositoryStats.mockResolvedValue({ repositories: [repositoryStats('integry/propr', 1)] });

    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes><Route path="/tasks" element={<TaskList limit={10} />} /></Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText('task table')).toBeInTheDocument();
    expect(mockGetTasks).toHaveBeenLastCalledWith('all', 20, 0, 'all', '');

    fireEvent.change(screen.getByTestId('status-filter'), { target: { value: 'active' } });

    await waitFor(() => expect(mockGetTasks).toHaveBeenLastCalledWith('active', 20, 0, 'all', ''));
    expect(await screen.findByText('task table')).toBeInTheDocument();
  });

  it('keeps populated results visible during a same-scope live refresh', async () => {
    const refreshRequest = deferred<Awaited<ReturnType<typeof getTasks>>>();
    mockGetTasks
      .mockResolvedValueOnce(populatedTaskResponse())
      .mockReturnValueOnce(refreshRequest.promise);
    mockGetRepositoryStats.mockResolvedValue({ repositories: [] });

    render(<MemoryRouter><TaskList limit={10} /></MemoryRouter>);
    expect(await screen.findByText('task table')).toBeInTheDocument();

    act(() => taskUpdateHandler?.({
      eventType: 'task:update', taskId: 'task-1', state: 'completed', previousState: 'processing',
      repository: 'integry/propr', timestamp: '2026-09-14T00:00:01Z',
    }));

    await waitFor(() => expect(mockGetTasks).toHaveBeenCalledTimes(2));
    expect(screen.getByText('task table')).toBeInTheDocument();
    expect(screen.queryByText(/Refreshing tasks/)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/No tasks found/)).not.toBeInTheDocument();

    await act(async () => { refreshRequest.resolve({ tasks: [], total: 0 }); });
    expect(await screen.findByText(/No tasks found/)).toBeInTheDocument();
  });
});

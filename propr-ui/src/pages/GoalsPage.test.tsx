import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGoals, type GoalListItem } from '../api/goalsApi';
import GoalsPage from './GoalsPage';

const mocks = vi.hoisted(() => ({
  demoMode: false,
  connected: true,
  taskUpdate: undefined as (() => void) | undefined,
  onTaskUpdate: vi.fn(),
}));

vi.mock('../api/goalsApi', async importOriginal => ({
  ...await importOriginal<typeof import('../api/goalsApi')>(),
  getGoals: vi.fn(),
}));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: mocks.demoMode }) }));
vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({ isConnected: mocks.connected, onTaskUpdate: mocks.onTaskUpdate }),
}));

const goal: GoalListItem = {
  id: 'goal-1', objective: 'Durable orchestration', repository: 'integry/propr', state: 'running',
  agentAlias: 'codex', requestedModel: 'requested', effectiveModel: 'effective', maxConcurrentTasks: 3,
  autoMergePolicy: 'manual', ultrafixEnabled: false, checklistTotal: 0, checklistCompleted: 0,
  activeTasks: 1, issuesProcessed: 2, issuesActive: 1, issuesFailed: 0, issuesBlocked: 0,
  tokenTotal: 0, elapsedSeconds: 0, pausedSeconds: 0, createdAt: '', updatedAt: '',
};

const Location = () => {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
};

function renderPage(entry = '/goals') {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/goals" element={<GoalsPage />} />
        <Route path="/goals/new" element={<div>New goal route</div>} />
      </Routes>
      <Location />
    </MemoryRouter>
  );
}

describe('GoalsPage', () => {
  beforeEach(() => {
    mocks.demoMode = false;
    mocks.connected = true;
    mocks.taskUpdate = undefined;
    mocks.onTaskUpdate.mockReset().mockImplementation((callback: () => void) => {
      mocks.taskUpdate = callback;
      return vi.fn();
    });
    vi.mocked(getGoals).mockReset();
  });

  it('renders loading, list data, all state filters, and URL-driven pagination', async () => {
    let resolveGoals!: (value: { goals: GoalListItem[]; total: number; hasMore: boolean }) => void;
    vi.mocked(getGoals).mockReturnValueOnce(new Promise(resolve => { resolveGoals = resolve; }));
    renderPage('/goals?state=planning');
    expect(screen.getByText('Loading goals…')).toBeInTheDocument();

    resolveGoals({ goals: [goal], total: 120, hasMore: true });
    expect(await screen.findByText('Durable orchestration')).toBeInTheDocument();
    expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'planning', page: 1, limit: 50 }));
    expect(screen.getByLabelText('Filter by state')).toHaveTextContent('QueuedPlanningRunningPausingPausedRecoveringCompletingCompletedFailedCancelled');

    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], total: 120, hasMore: true });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('page=2'));
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
  });

  it('debounces search into the URL and supports clearing it', async () => {
    vi.useFakeTimers();
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], total: 1, hasMore: false });
    renderPage();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('Durable orchestration')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search goals'), { target: { value: 'operator' } });
    expect(getGoals).not.toHaveBeenCalledWith(expect.objectContaining({ search: 'operator' }));
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('location')).toHaveTextContent('search=operator');
    expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'operator', page: 1 }));

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByTestId('location')).not.toHaveTextContent('search=');
    vi.useRealTimers();
  });

  it('silently refreshes list data after connected task socket updates', async () => {
    vi.mocked(getGoals)
      .mockResolvedValueOnce({ goals: [goal], total: 1, hasMore: false })
      .mockResolvedValueOnce({ goals: [{ ...goal, objective: 'Refreshed objective' }], total: 1, hasMore: false });
    renderPage();
    expect(await screen.findByText('Durable orchestration')).toBeInTheDocument();
    expect(mocks.taskUpdate).toBeTypeOf('function');

    await act(async () => { mocks.taskUpdate?.(); });
    expect(await screen.findByText('Refreshed objective')).toBeInTheDocument();
    expect(getGoals).toHaveBeenCalledTimes(2);
  });

  it('renders error and each empty-state branch', async () => {
    vi.mocked(getGoals).mockRejectedValue(new Error('Goals unavailable'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Goals unavailable');
  });

  it('renders no-goal, filtered, and searched empty states', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [], total: 0, hasMore: false });
    const plain = render(
      <MemoryRouter initialEntries={['/goals']}><GoalsPage /></MemoryRouter>
    );
    expect(await screen.findByText('No goals yet')).toBeInTheDocument();
    plain.unmount();

    const filtered = render(<MemoryRouter initialEntries={['/goals?state=paused']}><GoalsPage /></MemoryRouter>);
    expect(await screen.findByText('No matching goals')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    filtered.unmount();

    render(<MemoryRouter initialEntries={['/goals?search=missing']}><GoalsPage /></MemoryRouter>);
    expect(await screen.findByText('No results for “missing”')).toBeInTheDocument();
  });

  it('disables creation in demo mode and navigates when writable', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [], total: 0, hasMore: false });
    mocks.demoMode = true;
    renderPage();
    expect(await screen.findByRole('button', { name: 'Create first goal' })).toBeDisabled();
    expect(screen.getByTitle('Goal creation is disabled in demo mode')).toBeDisabled();
  });

  it('navigates to the creation route from the primary action', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], total: 1, hasMore: false });
    renderPage();
    await screen.findByText('Durable orchestration');
    fireEvent.click(screen.getByRole('button', { name: 'New Goal' }));
    expect(await screen.findByText('New goal route')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/goals/new');
  });
});

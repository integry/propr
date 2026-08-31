import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGoals, type GoalListItem } from '../api/goalsApi';
import GoalsPage from './GoalsPage';

const mocks = vi.hoisted(() => ({
  demoMode: false,
  connected: true,
  goalUpdate: undefined as ((payload: { schemaVersion: 1; goalId: string; version: number; latestSequence: number; timestamp: string; eventType: 'goal:summary:update' }) => void) | undefined,
  onGoalSummaryUpdate: vi.fn(),
  subscribeToGoalUpdates: vi.fn(),
  unsubscribeFromGoalUpdates: vi.fn(),
}));

vi.mock('../api/goalsApi', async importOriginal => ({
  ...await importOriginal<typeof import('../api/goalsApi')>(),
  getGoals: vi.fn(),
}));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: mocks.demoMode }) }));
vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: mocks.connected,
    onGoalSummaryUpdate: mocks.onGoalSummaryUpdate,
    subscribeToGoalUpdates: mocks.subscribeToGoalUpdates,
    unsubscribeFromGoalUpdates: mocks.unsubscribeFromGoalUpdates,
  }),
}));

const goal: GoalListItem = {
  goalId: 'goal-1',
  objective: 'Durable orchestration',
  repository: 'integry/propr',
  state: 'running',
  agent: 'codex',
  requestedModel: 'requested',
  effectiveModel: 'effective',
  maxActiveTasks: 3,
  mergePolicy: 'manual',
  ultrafixEnabled: false,
  ultrafixGoal: null,
  ultrafixMaxCycles: null,
  version: 2,
  nodeCount: 4,
  activeNodeCount: 1,
  latestSequence: 8,
  projection: { status: 'not-yet-projected' },
  createdAt: '2026-08-31T00:00:00Z',
  updatedAt: '2026-08-31T01:00:00Z',
};

const Location = () => {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
};

const HistoryControls = () => {
  const navigate = useNavigate();
  return <><button onClick={() => navigate(-1)}>Browser back</button><button onClick={() => navigate(1)}>Browser forward</button></>;
};

function renderPage(entries: string[] = ['/goals'], initialIndex = entries.length - 1) {
  const makeView = () => (
    <MemoryRouter initialEntries={entries} initialIndex={initialIndex}>
      <Routes>
        <Route path="/goals" element={<GoalsPage />} />
        <Route path="/goals/new" element={<div>New goal route</div>} />
        <Route path="/goals/:goalId" element={<div>Goal detail route</div>} />
      </Routes>
      <Location />
      <HistoryControls />
    </MemoryRouter>
  );
  const rendered = render(makeView());
  return { ...rendered, rerenderPage: () => rendered.rerender(makeView()) };
}

const updatePayload = (version: number) => ({
  schemaVersion: 1 as const,
  eventType: 'goal:summary:update' as const,
  goalId: 'goal-1',
  version,
  latestSequence: version + 8,
  timestamp: '2026-08-31T02:00:00Z',
});

describe('GoalsPage', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.demoMode = false;
    mocks.connected = true;
    mocks.goalUpdate = undefined;
    mocks.onGoalSummaryUpdate.mockReset().mockImplementation(callback => {
      mocks.goalUpdate = callback;
      return vi.fn();
    });
    mocks.subscribeToGoalUpdates.mockReset();
    mocks.unsubscribeFromGoalUpdates.mockReset();
    vi.mocked(getGoals).mockReset();
  });

  it('uses cursor history for next/previous navigation and never displays an inferred total', async () => {
    vi.mocked(getGoals)
      .mockResolvedValueOnce({ goals: [goal], nextCursor: 'Y3Vyc29yMg' })
      .mockResolvedValue({ goals: [{ ...goal, goalId: 'goal-2' }], nextCursor: null });
    renderPage(['/goals?state=planning']);
    expect(screen.getByText('Loading goals…')).toBeInTheDocument();
    expect(await screen.findByText('Durable orchestration')).toBeInTheDocument();
    expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'planning', limit: 50, cursor: undefined }), expect.any(Object));

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'Y3Vyc29yMg' }), expect.any(Object)));
    expect(screen.getByTestId('location')).toHaveTextContent('cursor=Y3Vyc29yMg');
    expect(screen.getByRole('navigation', { name: 'Goals pagination' })).toHaveTextContent('Page 2');
    expect(screen.queryByText(/of \d+/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: undefined }), expect.any(Object)));
    expect(screen.getByTestId('location')).not.toHaveTextContent('cursor=');
  });

  it('keeps filters on an empty later page and leaves Previous usable', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [], nextCursor: null });
    renderPage(['/goals?state=paused&repository=integry%2Fpropr&search=durable&cursor=cursor2&cursorHistory=%5Bnull%5D']);

    expect(await screen.findByText('No results for “durable”')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by state')).toHaveValue('paused');
    expect(screen.getByLabelText('Search goals')).toHaveValue('durable');
    const previous = screen.getByRole('button', { name: 'Previous page' });
    expect(previous).toBeEnabled();

    fireEvent.click(previous);
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({
      state: 'paused',
      repository: 'integry/propr',
      search: 'durable',
      cursor: undefined,
    }), expect.any(Object)));
    expect(screen.getByTestId('location')).toHaveTextContent('state=paused');
    expect(screen.getByTestId('location')).toHaveTextContent('repository=integry%2Fpropr');
    expect(screen.getByTestId('location')).toHaveTextContent('search=durable');
  });

  it('stops at the parseable cursor-history boundary and reverses the boundary page', async () => {
    const history = [null, ...Array.from({ length: 98 }, (_, index) => `cursor${index + 1}`)];
    const query = new URLSearchParams({
      cursor: 'cursor99',
      cursorHistory: JSON.stringify(history),
    });
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: 'cursor100' });
    renderPage([`/goals?${query.toString()}`]);

    await screen.findByText('Durable orchestration');
    expect(screen.getByRole('navigation', { name: 'Goals pagination' })).toHaveTextContent('Page 100');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor100' }),
      expect.any(Object)
    ));

    expect(screen.getByRole('navigation', { name: 'Goals pagination' })).toHaveTextContent('Page 101');
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    const boundaryUrl = new URL(screen.getByTestId('location').textContent ?? '', 'https://propr.invalid');
    expect(JSON.parse(boundaryUrl.searchParams.get('cursorHistory') ?? '[]')).toHaveLength(100);

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor99' }),
      expect.any(Object)
    ));
    expect(screen.getByRole('navigation', { name: 'Goals pagination' })).toHaveTextContent('Page 100');
  });

  it('provides mobile-visible search and resets cursor history when search changes', async () => {
    vi.useFakeTimers();
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    renderPage(['/goals?cursor=Y3Vyc29y&cursorHistory=%5Bnull%5D']);
    await act(async () => { await Promise.resolve(); });
    const search = screen.getByLabelText('Search goals');
    expect(search.closest('.hidden')).toBeNull();
    fireEvent.change(search, { target: { value: '  operator  ' } });
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('location')).toHaveTextContent('search=operator');
    expect(screen.getByTestId('location')).not.toHaveTextContent('cursor=');
    expect(search).toHaveValue('operator');
    expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'operator', cursor: undefined }), expect.any(Object));
  });

  it('canonically trims search and bounds astral input by Unicode code points', async () => {
    vi.useFakeTimers();
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    renderPage(['/goals?search=%20%20deep-link%20%20']);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('location')).toHaveTextContent('search=deep-link');
    expect(screen.getByLabelText('Search goals')).toHaveValue('deep-link');
    expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'deep-link' }), expect.any(Object));

    const search = screen.getByLabelText('Search goals');
    fireEvent.change(search, { target: { value: `  ${'🚀'.repeat(201)}  ` } });
    expect(Array.from((search as HTMLInputElement).value)).toHaveLength(200);
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { await Promise.resolve(); });
    expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ search: '🚀'.repeat(200) }), expect.any(Object));
  });

  it('cleans whitespace-only deep-link search as omitted', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    renderPage(['/goals?search=%20%20%09%20']);
    await screen.findByText('Durable orchestration');
    expect(screen.getByTestId('location')).not.toHaveTextContent('search=');
    expect(screen.getByLabelText('Search goals')).toHaveValue('');
    expect(getGoals).toHaveBeenCalledWith(expect.objectContaining({ search: undefined }), expect.any(Object));
  });

  it('sanitizes invalid legacy page/cursor URL state before requesting', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    renderPage(['/goals?page=NaN&cursor=bad%2Bcursor&cursorHistory=broken']);
    await screen.findByText('Durable orchestration');
    expect(screen.getByTestId('location')).not.toHaveTextContent('page=');
    expect(screen.getByTestId('location')).not.toHaveTextContent('cursor=');
    expect(getGoals).toHaveBeenCalledTimes(1);
    expect(getGoals).toHaveBeenCalledWith(expect.objectContaining({ cursor: undefined }), expect.any(Object));
  });

  it('rejects cursor history with an irreversible null entry', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    const query = new URLSearchParams({ cursor: 'cursor3', cursorHistory: JSON.stringify([null, 'cursor1', null]) });
    renderPage([`/goals?${query.toString()}`]);
    await screen.findByText('Durable orchestration');
    expect(screen.getByTestId('location')).not.toHaveTextContent('cursor=');
    expect(screen.getByTestId('location')).not.toHaveTextContent('cursorHistory=');
    expect(getGoals).toHaveBeenCalledTimes(1);
  });

  it('restores search, filter, and cursor state through browser back/forward navigation', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    const entries = [
      '/goals?search=first&state=paused',
      '/goals?search=second&state=running&cursor=Y3Vyc29yMg&cursorHistory=%5Bnull%5D',
    ];
    renderPage(entries);
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'second', state: 'running', cursor: 'Y3Vyc29yMg' }), expect.any(Object)));
    expect(screen.getByLabelText('Search goals')).toHaveValue('second');

    fireEvent.click(screen.getByText('Browser back'));
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'first', state: 'paused', cursor: undefined }), expect.any(Object)));
    expect(screen.getByLabelText('Search goals')).toHaveValue('first');
    expect(screen.getByLabelText('Filter by state')).toHaveValue('paused');

    fireEvent.click(screen.getByText('Browser forward'));
    await waitFor(() => expect(screen.getByLabelText('Search goals')).toHaveValue('second'));
    expect(screen.getByLabelText('Filter by state')).toHaveValue('running');
  });

  it('coalesces rapid versioned goal events and ignores already-applied versions', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    renderPage();
    await screen.findByText('Durable orchestration');
    vi.useFakeTimers();

    act(() => {
      mocks.goalUpdate?.(updatePayload(2));
      mocks.goalUpdate?.(updatePayload(3));
      mocks.goalUpdate?.(updatePayload(4));
      vi.advanceTimersByTime(100);
    });
    await act(async () => { await Promise.resolve(); });
    expect(getGoals).toHaveBeenCalledTimes(2);
    expect(mocks.subscribeToGoalUpdates).toHaveBeenCalledOnce();
  });

  it('ignores a stale response after filters start a newer request', async () => {
    let resolveFirst!: (value: { goals: GoalListItem[]; nextCursor: string | null }) => void;
    vi.mocked(getGoals)
      .mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ goals: [{ ...goal, objective: 'Newest result' }], nextCursor: null });
    renderPage();
    fireEvent.change(screen.getByLabelText('Filter by state'), { target: { value: 'running' } });
    expect(await screen.findByText('Newest result')).toBeInTheDocument();
    await act(async () => { resolveFirst({ goals: [{ ...goal, objective: 'Stale result' }], nextCursor: 'c3RhbGU' }); });
    expect(screen.queryByText('Stale result')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('does not display or paginate prior-query data when a changed filter request fails', async () => {
    vi.mocked(getGoals)
      .mockResolvedValueOnce({ goals: [goal], nextCursor: 'c3RhbGU' })
      .mockRejectedValueOnce(new Error('Filtered goals unavailable'));
    renderPage();
    await screen.findByText('Durable orchestration');
    expect(screen.getByRole('button', { name: 'Next page' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter by state'), { target: { value: 'failed' } });
    expect(screen.queryByText('Durable orchestration')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Filtered goals unavailable');
    expect(screen.queryByText('Durable orchestration')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('surfaces disconnect state and performs one coalesced resync after reconnect', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    const rendered = renderPage();
    await screen.findByText('Durable orchestration');

    mocks.connected = false;
    rendered.rerenderPage();
    expect(screen.getByText(/Goal updates are disconnected/)).toBeInTheDocument();
    expect(getGoals).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    mocks.connected = true;
    rendered.rerenderPage();
    act(() => { vi.advanceTimersByTime(100); });
    await act(async () => { await Promise.resolve(); });
    expect(getGoals).toHaveBeenCalledTimes(2);
  });

  it('keeps empty/error/demo gating and creation navigation intact', async () => {
    vi.mocked(getGoals).mockRejectedValueOnce(new Error('Goals unavailable'));
    const failed = renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Goals unavailable');
    failed.unmount();

    mocks.demoMode = true;
    vi.mocked(getGoals).mockResolvedValue({ goals: [], nextCursor: null });
    renderPage();
    expect(await screen.findByRole('button', { name: 'Create first goal' })).toBeDisabled();
    expect(screen.getByText(/Demo mode is read-only/)).toBeInTheDocument();
  });

  it('navigates to creation with the complete canonical goals return state', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    const history = JSON.stringify([null, 'cursor1']);
    const query = new URLSearchParams({
      state: 'planning',
      repository: 'integry/propr',
      search: 'durable work',
      cursor: 'cursor2',
      cursorHistory: history,
    });
    renderPage([`/goals?${query.toString()}`]);
    await screen.findByText('Durable orchestration');
    fireEvent.click(screen.getByRole('button', { name: 'New Goal' }));
    expect(await screen.findByText('New goal route')).toBeInTheDocument();
    const createUrl = new URL(screen.getByTestId('location').textContent ?? '', 'https://propr.invalid');
    const returnTarget = createUrl.searchParams.get('returnTo');
    expect(returnTarget).toBe(`/goals?${query.toString()}`);
  });

  it('preserves the complete validated list state through detail and browser back/forward', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    const query = new URLSearchParams({
      state: 'running', repository: 'integry/propr', search: 'durable work',
      cursor: 'cursor2', cursorHistory: JSON.stringify([null, 'cursor1']),
    });
    const listPath = `/goals?${query.toString()}`;
    renderPage([listPath]);
    fireEvent.click(await screen.findByRole('link', { name: 'Open goal: Durable orchestration' }));
    expect(await screen.findByText('Goal detail route')).toBeInTheDocument();
    const detailUrl = new URL(screen.getByTestId('location').textContent ?? '', 'https://propr.invalid');
    expect(detailUrl.searchParams.get('returnTo')).toBe(listPath);
    fireEvent.click(screen.getByText('Browser back'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(listPath));
    expect(screen.getByLabelText('Search goals')).toHaveValue('durable work');
    fireEvent.click(screen.getByText('Browser forward'));
    expect(await screen.findByText('Goal detail route')).toBeInTheDocument();
    expect(new URL(screen.getByTestId('location').textContent ?? '', 'https://propr.invalid').searchParams.get('returnTo')).toBe(listPath);
  });
});

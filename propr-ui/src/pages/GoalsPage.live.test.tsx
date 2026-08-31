import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalApiError, type GoalListItem } from '../api/goalsApi';
import { getGoalsApiMock, getGoalsPageMocks, goal, renderPage, resetGoalsPageMocks, updatePayload, user } from './GoalsPageTestHarness';

const mocks = getGoalsPageMocks();
const getGoals = getGoalsApiMock();

describe('GoalsPage', () => {
  beforeEach(resetGoalsPageMocks);

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

  it('clears prior-owner rows immediately and fences an in-flight completion across A to B', async () => {
    let resolveRefreshA!: (value: { goals: GoalListItem[]; nextCursor: string | null }) => void;
    let resolveB!: (value: { goals: GoalListItem[]; nextCursor: string | null }) => void;
    vi.mocked(getGoals)
      .mockResolvedValueOnce({ goals: [{ ...goal, objective: 'Owner A row' }], nextCursor: 'YQ' })
      .mockReturnValueOnce(new Promise(resolve => { resolveRefreshA = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveB = resolve; }));
    const view = renderPage();
    await screen.findByText('Owner A row');

    vi.useFakeTimers();
    act(() => {
      mocks.goalUpdate?.(updatePayload(3));
      vi.advanceTimersByTime(100);
    });
    await act(async () => { await Promise.resolve(); });
    expect(getGoals).toHaveBeenCalledTimes(2);
    vi.useRealTimers();

    mocks.user = user('owner-b', 'admin');
    view.rerenderPage();
    expect(screen.queryByText('Owner A row')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
    await act(async () => {
      resolveRefreshA({ goals: [{ ...goal, objective: 'Stale owner A completion' }], nextCursor: 'c3RhbGU' });
      resolveB({ goals: [{ ...goal, objective: 'Owner B row' }], nextCursor: null });
    });
    expect(await screen.findByText('Owner B row')).toBeInTheDocument();
    expect(screen.queryByText('Stale owner A completion')).not.toBeInTheDocument();
  });

  it.each([403, 404])('clears same-query rows and cursors after HTTP %s access loss', async status => {
    vi.mocked(getGoals)
      .mockResolvedValueOnce({ goals: [goal], nextCursor: 'YQ' })
      .mockRejectedValueOnce(new GoalApiError(status === 403 ? 'goal_access_denied' : 'goal_not_found', status, 'Goal unavailable'));
    renderPage();
    await screen.findByText('Durable orchestration');
    vi.useFakeTimers();
    act(() => {
      mocks.goalUpdate?.(updatePayload(3));
      vi.advanceTimersByTime(100);
    });
    await act(async () => { await Promise.resolve(); });
    vi.useRealTimers();
    expect(await screen.findByRole('alert')).toHaveTextContent('Goal unavailable');
    expect(screen.queryByText('Durable orchestration')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('keeps one invalidation request in flight, coalesces one trailing refresh, and commits the newest result', async () => {
    let resolveInFlight!: (value: { goals: GoalListItem[]; nextCursor: string | null }) => void;
    let resolveTrailing!: (value: { goals: GoalListItem[]; nextCursor: string | null }) => void;
    vi.mocked(getGoals)
      .mockResolvedValueOnce({ goals: [goal], nextCursor: null })
      .mockReturnValueOnce(new Promise(resolve => { resolveInFlight = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveTrailing = resolve; }));
    renderPage();
    await screen.findByText('Durable orchestration');
    vi.useFakeTimers();

    for (let interval = 0; interval < 5; interval += 1) {
      act(() => {
        mocks.goalUpdate?.({ ...updatePayload(interval + 3), goalId: interval % 2 === 0 ? 'goal-1' : 'off-page-goal' });
        vi.advanceTimersByTime(100);
      });
      await act(async () => { await Promise.resolve(); });
    }
    expect(getGoals).toHaveBeenCalledTimes(2);
    const inFlightSignal = vi.mocked(getGoals).mock.calls[1][1]?.signal;
    expect(inFlightSignal?.aborted).toBe(false);
    vi.useRealTimers();

    await act(async () => resolveInFlight({ goals: [{ ...goal, objective: 'Intermediate result' }], nextCursor: null }));
    await waitFor(() => expect(getGoals).toHaveBeenCalledTimes(3));
    expect(inFlightSignal?.aborted).toBe(false);
    await act(async () => resolveTrailing({ goals: [{ ...goal, objective: 'Newest result' }], nextCursor: null }));
    expect(await screen.findByText('Newest result')).toBeInTheDocument();
    expect(screen.queryByText('Intermediate result')).not.toBeInTheDocument();
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

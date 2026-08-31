import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalDetail, GoalEventsPage } from '../../api/goalsApi';
import { GoalApiError } from '../../api/goalsApi';
import { createGoalDetailHarness, getGoalDetailMocks, detail, event, message, page, resetGoalDetailMocks, user } from './useGoalDetailTestHarness';

const mocks = getGoalDetailMocks();
const Harness = createGoalDetailHarness();

describe('useGoalDetail replay and authorization', () => {
  beforeEach(resetGoalDetailMocks);
  afterEach(() => vi.useRealTimers());

  it('subscribes only after authorized history, uses exclusive reconnect cursors, deduplicates, and preserves older pagination', async () => {
    const view = render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('events')).toHaveTextContent('4,5'));
    await waitFor(() => expect(mocks.socket.emit).toHaveBeenCalledWith('subscribe:goal', expect.objectContaining({ ownerId: 'owner-a', repository: 'integry/propr', goalId: 'goal-1', afterSequence: 5 })));
    const deliver = (sequence: number) => mocks.listeners.get('goal:event')?.forEach(callback => callback({ ownerId: 'owner-a', repository: 'integry/propr', goalId: 'goal-1', event: event(sequence) }));
    act(() => { deliver(6); deliver(6); });
    expect(screen.getByTestId('events')).toHaveTextContent('4,5,6');
    fireEvent.click(screen.getByRole('button', { name: 'older' }));
    await waitFor(() => expect(screen.getByTestId('events')).toHaveTextContent('3,4,5,6'));

    mocks.connected = false; view.rerender(<Harness />);
    await waitFor(() => expect(mocks.getGoalEvents).toHaveBeenCalledWith('goal-1', expect.objectContaining({ afterSequence: 6 })));
    expect(mocks.socket.emit).toHaveBeenCalledWith('unsubscribe:goal', expect.objectContaining({ ownerId: 'owner-a', repository: 'integry/propr', goalId: 'goal-1' }));
    mocks.connected = true; view.rerender(<Harness />);
    await waitFor(() => expect(mocks.socket.emit).toHaveBeenCalledWith('subscribe:goal', expect.objectContaining({ afterSequence: 6 })));
  });

  it('clears scoped goal data immediately when the account changes while reauthorization is pending', async () => {
    const view = render(<Harness />);
    await screen.findByText('integry/propr');
    let resolveNext: (value: GoalDetail) => void = () => undefined;
    mocks.getGoal.mockImplementationOnce(() => new Promise(resolve => { resolveNext = resolve; }));
    mocks.user = user('owner-b');
    view.rerender(<Harness />);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveTextContent('empty'));
    expect(screen.getByTestId('events')).toBeEmptyDOMElement();
    await act(async () => resolveNext({ ...detail, goal: { ...detail.goal, repository: 'other/repo' } }));
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveTextContent('other/repo'));
  });

  it('surfaces optimistic conflicts and refreshes instead of overwriting concurrent state', async () => {
    mocks.pauseGoal.mockRejectedValueOnce(new GoalApiError('goal_version_conflict', 409, 'Version changed'));
    mocks.getGoal.mockResolvedValueOnce(detail).mockResolvedValueOnce({ ...detail, goal: { ...detail.goal, version: 2, state: 'paused' } });
    render(<Harness />);
    await screen.findByText('integry/propr');
    fireEvent.click(screen.getByRole('button', { name: 'pause' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/changed in another operator session/));
    expect(screen.getByTestId('version')).toHaveTextContent('2');
    expect(mocks.pauseGoal).toHaveBeenCalledWith('goal-1', 1, expect.any(String));
  });

  it('drains more than 200 replay events using each response cursor before reporting connected', async () => {
    const latest = { ...detail, latestSequence: 405 };
    mocks.getGoal.mockResolvedValue(latest);
    mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterSequence?: number }) => {
      if (options.afterSequence === 5) return Promise.resolve(page(Array.from({ length: 200 }, (_, index) => event(index + 6))));
      if (options.afterSequence === 205) return Promise.resolve(page(Array.from({ length: 200 }, (_, index) => event(index + 206))));
      if (options.afterSequence !== undefined) return Promise.resolve(page([]));
      return Promise.resolve(page([event(4), event(5)], true));
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('events')).toHaveTextContent(/405$/));
    expect(mocks.getGoalEvents).toHaveBeenCalledWith('goal-1', expect.objectContaining({ afterSequence: 5 }));
    expect(mocks.getGoalEvents).toHaveBeenCalledWith('goal-1', expect.objectContaining({ afterSequence: 205 }));
    expect(screen.getByTestId('connection')).toHaveTextContent('connected');
  });

  it('bounds far-over-limit replay and live ingestion while recovering duplicates and a post-eviction gap', async () => {
    const latestSequence = 1_205;
    mocks.getGoal.mockResolvedValue({ ...detail, latestSequence });
    mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterSequence?: number }) => {
      if (options.afterSequence === undefined) return Promise.resolve(page([event(4), event(5)], true));
      if (options.afterSequence >= latestSequence) return Promise.resolve(page([]));
      const start = options.afterSequence + 1;
      const end = Math.min(latestSequence, start + 199);
      return Promise.resolve(page(Array.from({ length: end - start + 1 }, (_, index) => event(start + index))));
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('events')).toHaveTextContent(/1205$/));
    let retained = (screen.getByTestId('events').textContent ?? '').split(',').filter(Boolean).map(Number);
    expect(retained).toHaveLength(1_000);
    expect(retained[0]).toBe(206);

    const deliver = (sequence: number) => mocks.listeners.get('goal:event')?.forEach(callback => callback({
      ownerId: 'owner-a', repository: 'integry/propr', goalId: 'goal-1', event: event(sequence),
    }));
    act(() => {
      for (let sequence = 1_206; sequence <= 2_405; sequence += 1) deliver(sequence);
      deliver(2_405);
    });
    retained = (screen.getByTestId('events').textContent ?? '').split(',').filter(Boolean).map(Number);
    expect(retained).toHaveLength(1_000);
    expect(retained[0]).toBe(1_406);
    expect(retained.at(-1)).toBe(2_405);

    mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterSequence?: number }) => {
      if (options.afterSequence === 2_405) return Promise.resolve(page([event(2_406), event(2_407)]));
      if (options.afterSequence !== undefined) return Promise.resolve(page([]));
      return Promise.resolve(page([event(4), event(5)], true));
    });
    act(() => deliver(2_407));
    await waitFor(() => expect(screen.getByTestId('events')).toHaveTextContent(/2407$/));
    retained = (screen.getByTestId('events').textContent ?? '').split(',').filter(Boolean).map(Number);
    expect(retained).toHaveLength(1_000);
    expect(retained[0]).toBe(1_408);
  });

  it('coalesces authoritative detail reconciliation when an over-limit gap evicts its early detail events', async () => {
    const latestSequence = 1_205;
    const refreshed = {
      ...detail,
      goal: { ...detail.goal, state: 'completed' as const, version: 2 },
      messages: [message('reconciled message')],
      stats: { ...detail.stats, tokens: { total: 321, byModel: [] } },
      latestSequence,
    };
    let gapOpened = false;
    mocks.getGoal.mockResolvedValueOnce(detail).mockResolvedValueOnce(refreshed);
    mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterSequence?: number }) => {
      if (options.afterSequence === undefined) return Promise.resolve(page([event(4), event(5)], true));
      if (!gapOpened || options.afterSequence >= latestSequence) return Promise.resolve(page([]));
      const start = options.afterSequence + 1;
      const end = Math.min(latestSequence, start + 199);
      const events = Array.from({ length: end - start + 1 }, (_, index) => {
        const sequence = start + index;
        if (sequence === 6) return { ...event(sequence), type: 'lifecycle' as const };
        if (sequence === 7) return { ...event(sequence), type: 'message' as const };
        if (sequence === 8) return { ...event(sequence), type: 'usage' as const };
        return event(sequence);
      });
      return Promise.resolve(page(events));
    });

    render(<Harness viewportAnchorSequence={1_000} />);
    await waitFor(() => expect(screen.getByTestId('connection')).toHaveTextContent('connected'));
    const replayRequestsBeforeGap = mocks.getGoalEvents.mock.calls.length;
    gapOpened = true;
    const deliver = (sequence: number) => mocks.listeners.get('goal:event')?.forEach(callback => callback({
      ownerId: 'owner-a', repository: 'integry/propr', goalId: 'goal-1', event: event(sequence),
    }));
    act(() => { deliver(latestSequence); deliver(latestSequence - 1); deliver(latestSequence); });

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('completed'));
    expect(screen.getByTestId('messages')).toHaveTextContent('reconciled message');
    expect(screen.getByTestId('tokens')).toHaveTextContent('321');
    expect(mocks.getGoal).toHaveBeenCalledTimes(2);

    const retained = (screen.getByTestId('events').textContent ?? '').split(',').filter(Boolean).map(Number);
    expect(retained).toHaveLength(1_000);
    expect(new Set(retained).size).toBe(1_000);
    expect(retained[0]).toBe(206);
    expect(retained.at(-1)).toBe(latestSequence);
    expect(retained).toContain(1_000);
    expect(retained).not.toEqual(expect.arrayContaining([6, 7, 8]));
    expect((screen.getByTestId('event-types').textContent ?? '').split(',').every(type => type === 'stdout')).toBe(true);

    const gapRequests = mocks.getGoalEvents.mock.calls.slice(replayRequestsBeforeGap)
      .filter(([, options]) => options.afterSequence !== undefined);
    expect(gapRequests.map(([, options]) => options.afterSequence)).toEqual([5, 205, 405, 605, 805, 1_005]);
    await act(async () => { await Promise.resolve(); });
    expect(mocks.getGoalEvents.mock.calls).toHaveLength(replayRequestsBeforeGap + 6);
    expect(mocks.getGoal).toHaveBeenCalledTimes(2);
  });

  it('bounds repeated older pages without losing a live tail delivered during the load', async () => {
    const stressRepetitions = 5;
    for (let repetition = 0; repetition < stressRepetitions; repetition += 1) {
      resetGoalDetailMocks();
      const firstOlder = (() => {
        let resolve!: (value: GoalEventsPage) => void;
        return { promise: new Promise<GoalEventsPage>(done => { resolve = done; }), resolve: (value: GoalEventsPage) => resolve(value) };
      })();
      mocks.getGoal.mockResolvedValue({ ...detail, latestSequence: 1_400 });
      mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterSequence?: number; beforeSequence?: number }) => {
        if (options.afterSequence !== undefined) return Promise.resolve(page([]));
        if (options.beforeSequence === undefined) return Promise.resolve(page(Array.from({ length: 200 }, (_, index) => event(1_201 + index)), true, 1_201));
        if (options.beforeSequence === 1_201) return firstOlder.promise;
        const start = options.beforeSequence - 200;
        return Promise.resolve(page(Array.from({ length: 200 }, (_, index) => event(start + index)), true, start));
      });
      const view = render(<Harness />);
      await waitFor(() => expect(screen.getByTestId('events')).toHaveTextContent(/^1201/));

      const olderButton = () => screen.getByRole('button', { name: 'older' });
      const waitForOlderPage = async (earliestSequence: number) => {
        await waitFor(() => {
          expect(screen.getByTestId('events')).toHaveTextContent(new RegExp(`^${earliestSequence},`));
          expect(screen.getByTestId('loading-older')).toHaveTextContent('false');
          expect(screen.getByTestId('has-more-before')).toHaveTextContent('true');
          expect(olderButton()).toBeEnabled();
        });
      };
      const loadOlder = async (earliestSequence: number) => {
        fireEvent.click(olderButton());
        expect(screen.getByTestId('loading-older')).toHaveTextContent('true');
        expect(olderButton()).toBeDisabled();
        await waitForOlderPage(earliestSequence);
      };

      fireEvent.click(olderButton());
      expect(screen.getByTestId('loading-older')).toHaveTextContent('true');
      expect(olderButton()).toBeDisabled();
      const deliver = (sequence: number) => mocks.listeners.get('goal:event')?.forEach(callback => callback({
        ownerId: 'owner-a', repository: 'integry/propr', goalId: 'goal-1', event: event(sequence),
      }));
      act(() => deliver(1_401));
      await act(async () => firstOlder.resolve(page(Array.from({ length: 200 }, (_, index) => event(1_001 + index)), true, 1_001)));
      await waitForOlderPage(1_001);

      for (const earliestSequence of [801, 601, 401, 201]) await loadOlder(earliestSequence);

      const olderCursors = mocks.getGoalEvents.mock.calls
        .map(([, options]) => options.beforeSequence)
        .filter((cursor): cursor is number => cursor !== undefined);
      expect(olderCursors).toEqual([1_201, 1_001, 801, 601, 401]);
      const retained = (screen.getByTestId('events').textContent ?? '').split(',').filter(Boolean).map(Number);
      expect(retained).toHaveLength(1_000);
      expect(new Set(retained).size).toBe(1_000);
      expect(retained.at(-1)).toBe(1_401);
      expect(retained.filter(sequence => sequence === 1_401)).toHaveLength(1);
      expect(retained).toContain(201);
      expect(retained).toContain(1_201);
      view.unmount();
    }
  });

  it('immediately reconciles detail when initial history is newer than its snapshot', async () => {
    vi.useFakeTimers();
    const paused = { ...detail, goal: { ...detail.goal, state: 'paused' as const, version: 2 }, latestSequence: 6 };
    mocks.getGoal.mockResolvedValueOnce(detail).mockResolvedValueOnce(paused);
    mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterSequence?: number }) => {
      if (options.afterSequence === 6) return Promise.resolve(page([]));
      if (options.afterSequence !== undefined) return Promise.resolve(page([]));
      return Promise.resolve(page([event(4), event(5), { ...event(6), type: 'lifecycle' }]));
    });

    render(<Harness />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(mocks.getGoal).toHaveBeenCalledTimes(2);
    expect(mocks.getGoalEvents).toHaveBeenCalledWith('goal-1', expect.objectContaining({ afterSequence: 6 }));
    expect(screen.getByTestId('events')).toHaveTextContent('4,5,6');
    expect(screen.getByTestId('state')).toHaveTextContent('paused');
    expect(screen.getByTestId('version')).toHaveTextContent('2');
  });

  it('retries replay reconciliation once against a mutation revision without committing stale detail', async () => {
    const replayTarget = { ...detail, latestSequence: 6 };
    const converged = { ...replayTarget, goal: { ...detail.goal, state: 'paused' as const, version: 2 } };
    const foreign = { ...replayTarget, goal: { ...detail.goal, goalId: 'goal-2', repository: 'sensitive/foreign', version: 99 } };
    let resolveStaleRefresh!: (value: GoalDetail) => void;
    let resolveRetry!: (value: GoalDetail) => void;
    mocks.getGoal
      .mockResolvedValueOnce(replayTarget)
      .mockImplementationOnce(() => new Promise(resolve => { resolveStaleRefresh = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveRetry = resolve; }));
    mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterSequence?: number }) => {
      if (options.afterSequence === 5) return Promise.resolve(page([{ ...event(6), type: 'lifecycle' }]));
      if (options.afterSequence !== undefined) return Promise.resolve(page([]));
      return Promise.resolve(page([event(4), event(5)]));
    });

    render(<Harness />);
    await waitFor(() => expect(mocks.getGoal).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'pause' }));
    await waitFor(() => expect(screen.getByTestId('version')).toHaveTextContent('2'));
    expect(screen.getByTestId('state')).toHaveTextContent('pausing');

    await act(async () => resolveStaleRefresh(foreign));
    await waitFor(() => expect(mocks.getGoal).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId('detail')).toHaveTextContent('integry/propr');
    expect(screen.getByTestId('version')).toHaveTextContent('2');
    expect(screen.getByTestId('state')).toHaveTextContent('pausing');

    await act(async () => resolveRetry(converged));
    expect(screen.getByTestId('state')).toHaveTextContent('paused');
    await act(async () => { await Promise.resolve(); });
    expect(mocks.getGoal).toHaveBeenCalledTimes(3);
    expect(mocks.getGoal.mock.calls.every(([requestedGoalId]) => requestedGoalId === 'goal-1')).toBe(true);
  });

  it('keeps REST fallback active after connected-transport catch-up failure until replay recovers', async () => {
    let attempts = 0;
    mocks.getGoal.mockResolvedValue({ ...detail, latestSequence: 6 });
    mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterSequence?: number }) => {
      if (options.afterSequence === undefined) return Promise.resolve(page([event(4), event(5)], true));
      attempts += 1;
      if (attempts <= 3) return Promise.resolve({ ...page([]), nextCursor: 5 });
      return Promise.resolve(page([event(6)]));
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('events')).toHaveTextContent('4,5,6'));
    expect(attempts).toBeGreaterThanOrEqual(4);
    expect(mocks.connected).toBe(true);
    expect(screen.getByTestId('connection')).toHaveTextContent('connected');
  });
});

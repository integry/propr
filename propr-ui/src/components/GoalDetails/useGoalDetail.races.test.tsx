import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalDetail, GoalEventsPage } from '../../api/goalsApi';
import { GoalApiError, GoalContractError, GoalMutationUncertainError } from '../../api/goalsApi';
import { createGoalDetailHarness, getGoalDetailMocks, detail, event, message, page, resetGoalDetailMocks, user } from './useGoalDetailTestHarness';

const mocks = getGoalDetailMocks();
const Harness = createGoalDetailHarness();

describe('useGoalDetail replay and authorization', () => {
  beforeEach(resetGoalDetailMocks);
  afterEach(() => vi.useRealTimers());

  it('invalidates synchronously on a socket-triggered 403 and unsubscribes controls/data', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('connection')).toHaveTextContent('connected'));
    mocks.getGoal.mockRejectedValueOnce(new GoalApiError('goal_access_denied', 403, 'Forbidden'));
    act(() => mocks.listeners.get('goal:event')?.forEach(callback => callback({ ownerId: 'owner-a', repository: 'integry/propr', goalId: 'goal-1', event: { ...event(6), eventType: 'lifecycle.state_changed', kind: 'lifecycle' } })));
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveTextContent('empty'));
    expect(screen.getByTestId('events')).toBeEmptyDOMElement();
    expect(mocks.socket.emit).toHaveBeenCalledWith('unsubscribe:goal', expect.objectContaining({ goalId: 'goal-1' }));
  });

  it('periodically probes authorization on a healthy socket and stays cleared after silent room revocation', async () => {
    vi.useFakeTimers();
    render(<Harness />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByTestId('detail')).toHaveTextContent('integry/propr');
    expect(screen.getByTestId('connection')).toHaveTextContent('connected');
    const eventRequests = mocks.getGoalEvents.mock.calls.length;
    mocks.getGoal.mockRejectedValueOnce(new GoalApiError('goal_access_denied', 403, 'Forbidden'));

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(screen.getByTestId('detail')).toHaveTextContent('empty');
    expect(screen.getByTestId('events')).toBeEmptyDOMElement();
    expect(screen.getByTestId('readonly')).toHaveTextContent('true');
    expect(mocks.getGoalEvents).toHaveBeenCalledTimes(eventRequests);
    expect(mocks.socket.emit).toHaveBeenCalledWith('unsubscribe:goal', expect.objectContaining({ goalId: 'goal-1' }));
    const detailRequests = mocks.getGoal.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.getGoal).toHaveBeenCalledTimes(detailRequests);
    expect(screen.getByTestId('detail')).toHaveTextContent('empty');
  });

  it('recovers a terminal event missed by a healthy socket when the detail probe advances', async () => {
    vi.useFakeTimers();
    let probeAdvanced = false;
    mocks.getGoal
      .mockResolvedValueOnce(detail)
      .mockImplementationOnce(() => {
        probeAdvanced = true;
        return Promise.resolve({ ...detail, latestSequence: 6 });
      });
    mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterCursor?: string }) => {
      if (options.afterCursor === 'cursor:5') return Promise.resolve(page(probeAdvanced ? [event(6)] : []));
      if (options.afterCursor !== undefined) return Promise.resolve(page([]));
      return Promise.resolve(page([event(4), event(5)], true));
    });

    render(<Harness />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByTestId('events')).toHaveTextContent('4,5');

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(screen.getByTestId('events')).toHaveTextContent('4,5,6');
    expect(mocks.getGoalEvents).toHaveBeenCalledWith('goal-1', expect.objectContaining({ afterCursor: 'cursor:5' }));
  });

  it('does not let a delayed healthy probe overwrite a successful mutation', async () => {
    vi.useFakeTimers();
    render(<Harness />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    let resolveProbe!: (value: GoalDetail) => void;
    mocks.getGoal.mockImplementationOnce(() => new Promise(resolve => { resolveProbe = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'pause' }));
      await Promise.resolve();
    });
    expect(screen.getByTestId('version')).toHaveTextContent('2');

    await act(async () => resolveProbe(detail));

    expect(screen.getByTestId('version')).toHaveTextContent('2');
  });

  it('uses healthy probes to rescope repository rooms and fences goal identity changes', async () => {
    vi.useFakeTimers();
    const view = render(<Harness />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    mocks.getGoal.mockResolvedValueOnce({ ...detail, goal: { ...detail.goal, repository: 'integry/renamed' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByTestId('detail')).toHaveTextContent('integry/renamed');
    expect(mocks.socket.emit).toHaveBeenCalledWith('unsubscribe:goal', expect.objectContaining({ repository: 'integry/propr', goalId: 'goal-1' }));
    expect(mocks.socket.emit).toHaveBeenCalledWith('subscribe:goal', expect.objectContaining({ repository: 'integry/renamed', goalId: 'goal-1' }));

    let resolveStaleProbe!: (value: GoalDetail) => void;
    mocks.getGoal.mockImplementationOnce(() => new Promise(resolve => { resolveStaleProbe = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    const goalTwo = { ...detail, goal: { ...detail.goal, goalId: 'goal-2', repository: 'integry/goal-two' } };
    mocks.getGoal.mockImplementation((goalId: string) => Promise.resolve(goalId === 'goal-2' ? goalTwo : detail));
    mocks.getGoalEvents.mockImplementation((goalId: string, options: { afterCursor?: string }) => {
      if (options.afterCursor !== undefined) return Promise.resolve(page([], false));
      return Promise.resolve(page([event(4, goalId), event(5, goalId)], false));
    });
    view.rerender(<Harness goalId="goal-2" />);
    expect(screen.getByTestId('detail')).toHaveTextContent('empty');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByTestId('detail')).toHaveTextContent('integry/goal-two');
    expect(screen.getByTestId('events')).toHaveTextContent('4,5');
    expect(mocks.socket.emit).toHaveBeenCalledWith('unsubscribe:goal', expect.objectContaining({ repository: 'integry/renamed', goalId: 'goal-1' }));
    expect(mocks.socket.emit).toHaveBeenCalledWith('subscribe:goal', expect.objectContaining({ repository: 'integry/goal-two', goalId: 'goal-2' }));
    await act(async () => resolveStaleProbe({ ...detail, goal: { ...detail.goal, repository: 'sensitive/stale' } }));
    expect(screen.getByTestId('detail')).toHaveTextContent('integry/goal-two');
  });

  it('discards a detail-changing recovery summary when the goal identity switches mid-gap', async () => {
    const view = render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('connection')).toHaveTextContent('connected'));

    let resolveStalePage!: (value: GoalEventsPage) => void;
    const stalePage = new Promise<GoalEventsPage>(resolve => { resolveStalePage = resolve; });
    const goalTwo = { ...detail, goal: { ...detail.goal, goalId: 'goal-2', repository: 'integry/goal-two' } };
    mocks.getGoal.mockImplementation((goalId: string) => Promise.resolve(goalId === 'goal-2' ? goalTwo : detail));
    mocks.getGoalEvents.mockImplementation((goalId: string, options: { afterCursor?: string }) => {
      if (goalId === 'goal-1' && options.afterCursor === 'cursor:5') return stalePage;
      if (options.afterCursor !== undefined) return Promise.resolve(page([]));
      return Promise.resolve(page([event(4, goalId), event(5, goalId)], false));
    });
    act(() => mocks.listeners.get('goal:event')?.forEach(callback => callback({
      ownerId: 'owner-a', repository: 'integry/propr', goalId: 'goal-1', event: event(1_205),
    })));
    await waitFor(() => expect(mocks.getGoalEvents).toHaveBeenCalledWith('goal-1', expect.objectContaining({ afterCursor: 'cursor:5' })));

    view.rerender(<Harness goalId="goal-2" />);
    await waitFor(() => expect(screen.getByTestId('detail')).toHaveTextContent('integry/goal-two'));
    await act(async () => {
      resolveStalePage(page(Array.from({ length: 200 }, (_, index) => ({
        ...event(index + 6), eventType: index === 0 ? 'lifecycle.state_changed' as const : 'provider.output' as const,
        kind: index === 0 ? 'lifecycle' as const : 'output' as const,
      }))));
    });

    expect(screen.getByTestId('detail')).toHaveTextContent('integry/goal-two');
    expect(screen.getByTestId('events')).toHaveTextContent('4,5');
    expect(mocks.getGoal.mock.calls.map(([goalId]) => goalId)).toEqual(['goal-1', 'goal-2']);
  });

  it('uses authoritative backward cursors across sparse and empty pages', async () => {
    mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterCursor?: string; beforeCursor?: string }) => {
      if (options.beforeCursor === 'cursor:20') return Promise.resolve(page([], true, 10));
      if (options.beforeCursor === 'cursor:10') return Promise.resolve(page([event(2)], false, 1));
      if (options.afterCursor !== undefined) return Promise.resolve(page([], false));
      return Promise.resolve(page([event(4), event(5)], true, 20));
    });
    render(<Harness />);
    await screen.findByText('integry/propr');
    fireEvent.click(screen.getByRole('button', { name: 'older' }));
    await waitFor(() => expect(mocks.getGoalEvents).toHaveBeenCalledWith('goal-1', expect.objectContaining({ beforeCursor: 'cursor:20' })));
    expect(screen.getByTestId('events')).toHaveTextContent('4,5');
    fireEvent.click(screen.getByRole('button', { name: 'older' }));
    await waitFor(() => expect(mocks.getGoalEvents).toHaveBeenCalledWith('goal-1', expect.objectContaining({ beforeCursor: 'cursor:10' })));
    expect(screen.getByTestId('events')).toHaveTextContent('2,4,5');
  });

  it('stops older pagination when an authoritative cursor makes no progress', async () => {
    mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterCursor?: string; beforeCursor?: string }) => {
      if (options.beforeCursor === 'cursor:20') return Promise.resolve(page([], true, 20));
      if (options.afterCursor !== undefined) return Promise.resolve(page([], false));
      return Promise.resolve(page([event(4), event(5)], true, 20));
    });
    render(<Harness />);
    await screen.findByText('integry/propr');
    fireEvent.click(screen.getByRole('button', { name: 'older' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/repeated or omitted/));
    fireEvent.click(screen.getByRole('button', { name: 'older' }));
    expect(mocks.getGoalEvents.mock.calls.filter(([, options]) => options.beforeCursor === 'cursor:20')).toHaveLength(1);
  });

  it('never commits a deferred load-older response after the authorization identity changes', async () => {
    let resolveOlder!: (value: GoalEventsPage) => void;
    mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterCursor?: string; beforeCursor?: string }) => {
      if (options.beforeCursor === 'cursor:20') return new Promise(resolve => { resolveOlder = resolve; });
      if (options.afterCursor !== undefined) return Promise.resolve(page([]));
      return Promise.resolve(page([event(4), event(5)], true, 20));
    });
    const view = render(<Harness />);
    await screen.findByText('integry/propr');
    fireEvent.click(screen.getByRole('button', { name: 'older' }));
    mocks.user = user('owner-b'); view.rerender(<Harness />);
    await waitFor(() => expect(screen.getByTestId('events')).toBeEmptyDOMElement());
    await act(async () => resolveOlder(page([event(3)], true, 10)));
    expect(screen.getByTestId('events')).not.toHaveTextContent('3');
  });

  it('retains exact free-form and canned intents after malformed 2xx response decoding', async () => {
    const malformedResponse = () => new GoalMutationUncertainError(new GoalContractError('response.message.state', 'a canonical state'));
    mocks.sendGoalMessage
      .mockRejectedValueOnce(malformedResponse())
      .mockResolvedValueOnce(message('alpha'))
      .mockRejectedValueOnce(malformedResponse())
      .mockResolvedValueOnce(message("Summarize what's done."));
    render(<Harness />); await screen.findByText('integry/propr');

    fireEvent.click(screen.getByRole('button', { name: 'message alpha' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('response.message.state'));
    const freeFormCall = mocks.sendGoalMessage.mock.calls[0];
    fireEvent.click(screen.getByRole('button', { name: 'message alpha' }));
    await waitFor(() => expect(mocks.sendGoalMessage).toHaveBeenCalledTimes(2));
    expect(mocks.sendGoalMessage.mock.calls[1][1]).toEqual(freeFormCall[1]);
    expect(mocks.sendGoalMessage.mock.calls[1][2]).toBe(freeFormCall[2]);

    fireEvent.click(screen.getByRole('button', { name: 'message canned' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('response.message.state'));
    expect(mocks.sendGoalMessage).toHaveBeenCalledTimes(3);
    const cannedCall = mocks.sendGoalMessage.mock.calls[2];
    fireEvent.click(screen.getByRole('button', { name: 'message canned' }));
    await waitFor(() => expect(mocks.sendGoalMessage).toHaveBeenCalledTimes(4));
    expect(mocks.sendGoalMessage.mock.calls[3][1]).toEqual(cannedCall[1]);
    expect(mocks.sendGoalMessage.mock.calls[3][2]).toBe(cannedCall[2]);
  });

  it('reuses uncertain message keys, rotates for edits and definitive outcomes, and sends stable retry intent', async () => {
    mocks.sendGoalMessage.mockRejectedValueOnce(new TypeError('response lost')).mockResolvedValue(message('alpha'));
    render(<Harness />); await screen.findByText('integry/propr');
    fireEvent.click(screen.getByRole('button', { name: 'message alpha' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('response lost'));
    const firstKey = mocks.sendGoalMessage.mock.calls[0][2];
    fireEvent.click(screen.getByRole('button', { name: 'message alpha' }));
    await waitFor(() => expect(mocks.sendGoalMessage).toHaveBeenCalledTimes(2));
    expect(mocks.sendGoalMessage.mock.calls[1][2]).toBe(firstKey);
    fireEvent.click(screen.getByRole('button', { name: 'message alpha' }));
    await waitFor(() => expect(mocks.sendGoalMessage).toHaveBeenCalledTimes(3));
    expect(mocks.sendGoalMessage.mock.calls[2][2]).not.toBe(firstKey);

    mocks.sendGoalMessage.mockRejectedValueOnce(new TypeError('uncertain edit'));
    fireEvent.click(screen.getByRole('button', { name: 'message alpha' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('uncertain edit'));
    const editKey = mocks.sendGoalMessage.mock.calls[3][2];
    fireEvent.click(screen.getByRole('button', { name: 'message beta' }));
    await waitFor(() => expect(mocks.sendGoalMessage).toHaveBeenCalledTimes(5));
    expect(mocks.sendGoalMessage.mock.calls[4][2]).not.toBe(editKey);

    mocks.sendGoalMessage.mockRejectedValueOnce(new TypeError('uncertain retry'));
    fireEvent.click(screen.getByRole('button', { name: 'retry failed' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('uncertain retry'));
    const retryCall = mocks.sendGoalMessage.mock.calls[5];
    expect(retryCall[1]).toMatchObject({ retryOfMessageId: 'failed-1' });
    fireEvent.click(screen.getByRole('button', { name: 'retry failed' }));
    await waitFor(() => expect(mocks.sendGoalMessage).toHaveBeenCalledTimes(7));
    expect(mocks.sendGoalMessage.mock.calls[6][2]).toBe(retryCall[2]);
  });

  it('coalesces double-clicks and rotates keys after conflict while retaining canned uncertain intent', async () => {
    let resolveSend!: (value: ReturnType<typeof message>) => void;
    mocks.sendGoalMessage.mockReturnValueOnce(new Promise(resolve => { resolveSend = resolve; }));
    render(<Harness />); await screen.findByText('integry/propr');
    const alpha = screen.getByRole('button', { name: 'message alpha' });
    fireEvent.click(alpha); fireEvent.click(alpha);
    expect(mocks.sendGoalMessage).toHaveBeenCalledOnce();
    await act(async () => resolveSend(message('alpha')));

    mocks.sendGoalMessage.mockRejectedValueOnce(new GoalApiError('goal_idempotency_conflict', 409, 'Conflict'));
    fireEvent.click(alpha); await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Conflict'));
    const conflictKey = mocks.sendGoalMessage.mock.calls[1][2];
    fireEvent.click(alpha); await waitFor(() => expect(mocks.sendGoalMessage).toHaveBeenCalledTimes(3));
    expect(mocks.sendGoalMessage.mock.calls[2][2]).not.toBe(conflictKey);

    mocks.sendGoalMessage.mockRejectedValueOnce(new TypeError('canned response lost'));
    const canned = screen.getByRole('button', { name: 'message canned' });
    fireEvent.click(canned); await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('canned response lost'));
    const cannedKey = mocks.sendGoalMessage.mock.calls[3][2];
    fireEvent.click(canned); await waitFor(() => expect(mocks.sendGoalMessage).toHaveBeenCalledTimes(5));
    expect(mocks.sendGoalMessage.mock.calls[4][2]).toBe(cannedKey);
  });
});

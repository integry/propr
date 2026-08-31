import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../api/proprTypes';
import type { GoalDetail, GoalEvent, GoalEventsPage } from '../../api/goalsApi';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    user: null as CurrentUser | null,
    connected: true,
    demo: false,
    listeners,
    socket: {
      emit: vi.fn(),
      on: vi.fn((name: string, callback: (payload: unknown) => void) => {
        const callbacks = listeners.get(name) ?? new Set(); callbacks.add(callback); listeners.set(name, callbacks);
      }),
      off: vi.fn((name: string, callback: (payload: unknown) => void) => listeners.get(name)?.delete(callback)),
    },
    getGoal: vi.fn(), getGoalEvents: vi.fn(), getInstanceCatalog: vi.fn(), pauseGoal: vi.fn(),
    sendGoalMessage: vi.fn(), cancelGoalMessage: vi.fn(),
  };
});

vi.mock('../../contexts/AuthContext', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('../../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: mocks.demo, isLoading: false }) }));
vi.mock('../../contexts/useSocket', () => ({ useSocket: () => ({ socket: mocks.socket, isConnected: mocks.connected }) }));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: mocks.getInstanceCatalog }));
vi.mock('../../api/goalsApi', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/goalsApi')>(),
  getGoal: mocks.getGoal,
  getGoalEvents: mocks.getGoalEvents,
  pauseGoal: mocks.pauseGoal, resumeGoal: vi.fn(), cancelGoal: vi.fn(), requestGoalModel: vi.fn(),
  sendGoalMessage: mocks.sendGoalMessage, cancelGoalMessage: mocks.cancelGoalMessage,
}));

import { useGoalDetail } from './useGoalDetail';
import { GoalApiError, GoalContractError, GoalMutationUncertainError } from '../../api/goalsApi';

const timestamp = '2026-08-31T10:00:00.000Z';
const user = (id: string): CurrentUser => ({ id, login: id, username: id, displayName: id, email: null, avatarUrl: null, role: 'member', permissions: [], authorizationSource: 'local' });
const event = (sequence: number, goalId = 'goal-1'): GoalEvent => ({ goalId, sequence, type: 'stdout', source: 'codex', timestamp, turnId: 'turn-1', content: `line ${sequence}`, payload: null });
const page = (events: GoalEvent[], hasMoreBefore = false, previousCursor = events[0]?.sequence ?? null): GoalEventsPage => ({ events, hasMoreBefore, previousCursor, nextCursor: events.at(-1)?.sequence ?? null });
const message = (body = 'alpha', messageId = 'message-1') => ({
  messageId, sequence: 10, body, predefinedKind: null, state: 'delivered' as const, responseSource: null,
  response: null, error: null, createdAt: timestamp, updatedAt: timestamp,
});
const detail: GoalDetail = {
  goal: { goalId: 'goal-1', objective: 'Operator goal', repository: 'integry/propr', state: 'running', agent: 'codex', requestedModel: 'gpt', effectiveModel: 'gpt', maxActiveTasks: 2, mergePolicy: 'manual', ultrafixEnabled: false, ultrafixGoal: null, ultrafixMaxCycles: null, version: 1, terminalReason: null, createdAt: timestamp, updatedAt: timestamp },
  hierarchy: { nodes: [], dependencies: [] }, providerTodos: [], messages: [],
  stats: { issues: { total: 0, ready: 0, active: 0, processed: 0, failed: 0, blocked: 0 }, pullRequests: { open: 0, reviewPending: 0, ultrafixPending: 0, mergeReady: 0, merged: 0 }, tokens: { total: 0, byModel: [] }, time: { elapsedSeconds: 0, activeSeconds: 0, pausedSeconds: 0, recoverySeconds: 0 } },
  recovery: { state: 'healthy', attempt: 0, reason: null }, epicPrUrl: null, completionBlockers: [], latestSequence: 5,
};

const Harness = ({ goalId = 'goal-1' }: { goalId?: string }) => {
  const goal = useGoalDetail(goalId);
  const retry = { ...message('retry me', 'failed-1'), state: 'failed' as const };
  return <><div data-testid="detail">{goal.detail?.goal.repository ?? 'empty'}</div><div data-testid="version">{goal.detail?.goal.version ?? 'none'}</div><div data-testid="events">{goal.events.map(item => item.sequence).join(',')}</div><div data-testid="connection">{goal.connectionState}</div><div data-testid="readonly">{String(goal.readOnly)}</div><div role="alert">{goal.actionError}</div><button type="button" onClick={() => void goal.loadOlder()}>older</button><button type="button" onClick={() => void goal.pause()}>pause</button><button type="button" onClick={() => void goal.sendMessage({ body: 'alpha' })}>message alpha</button><button type="button" onClick={() => void goal.sendMessage({ body: 'beta' })}>message beta</button><button type="button" onClick={() => void goal.sendMessage({ body: "Summarize what's done.", predefinedKind: 'whats_done' })}>message canned</button><button type="button" onClick={() => void goal.retryMessage(retry)}>retry failed</button></>;
};

describe('useGoalDetail replay and authorization', () => {
  beforeEach(() => {
    mocks.user = user('owner-a'); mocks.connected = true; mocks.demo = false;
    mocks.socket.emit.mockClear(); mocks.socket.on.mockClear(); mocks.socket.off.mockClear(); mocks.listeners.clear();
    mocks.getGoal.mockReset().mockResolvedValue(detail);
    mocks.pauseGoal.mockReset().mockResolvedValue({ ...detail.goal, state: 'pausing', version: 2 });
    mocks.sendGoalMessage.mockReset().mockImplementation((_goalId, params) => Promise.resolve(message(params.body)));
    mocks.cancelGoalMessage.mockReset();
    mocks.getInstanceCatalog.mockReset().mockResolvedValue({ agents: [], repositories: [], defaultAgentAlias: null });
    mocks.getGoalEvents.mockReset().mockImplementation((_goalId: string, options: { afterSequence?: number; beforeSequence?: number }) => {
      if (options.beforeSequence === 4) return Promise.resolve(page([event(3)], false));
      if (options.afterSequence !== undefined) return Promise.resolve(page([], false));
      return Promise.resolve(page([event(4), event(5)], true));
    });
  });

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

  it('invalidates synchronously on a socket-triggered 403 and unsubscribes controls/data', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('connection')).toHaveTextContent('connected'));
    mocks.getGoal.mockRejectedValueOnce(new GoalApiError('goal_access_denied', 403, 'Forbidden'));
    act(() => mocks.listeners.get('goal:event')?.forEach(callback => callback({ ownerId: 'owner-a', repository: 'integry/propr', goalId: 'goal-1', event: { ...event(6), type: 'lifecycle' } })));
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
    mocks.getGoalEvents.mockImplementation((goalId: string, options: { afterSequence?: number }) => {
      if (options.afterSequence !== undefined) return Promise.resolve(page([], false));
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

  it('uses authoritative backward cursors across sparse and empty pages', async () => {
    mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterSequence?: number; beforeSequence?: number }) => {
      if (options.beforeSequence === 20) return Promise.resolve(page([], true, 10));
      if (options.beforeSequence === 10) return Promise.resolve(page([event(2)], false, 1));
      if (options.afterSequence !== undefined) return Promise.resolve(page([], false));
      return Promise.resolve(page([event(4), event(5)], true, 20));
    });
    render(<Harness />);
    await screen.findByText('integry/propr');
    fireEvent.click(screen.getByRole('button', { name: 'older' }));
    await waitFor(() => expect(mocks.getGoalEvents).toHaveBeenCalledWith('goal-1', expect.objectContaining({ beforeSequence: 20 })));
    expect(screen.getByTestId('events')).toHaveTextContent('4,5');
    fireEvent.click(screen.getByRole('button', { name: 'older' }));
    await waitFor(() => expect(mocks.getGoalEvents).toHaveBeenCalledWith('goal-1', expect.objectContaining({ beforeSequence: 10 })));
    expect(screen.getByTestId('events')).toHaveTextContent('2,4,5');
  });

  it('stops older pagination when an authoritative cursor makes no progress', async () => {
    mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterSequence?: number; beforeSequence?: number }) => {
      if (options.beforeSequence === 20) return Promise.resolve(page([], true, 20));
      if (options.afterSequence !== undefined) return Promise.resolve(page([], false));
      return Promise.resolve(page([event(4), event(5)], true, 20));
    });
    render(<Harness />);
    await screen.findByText('integry/propr');
    fireEvent.click(screen.getByRole('button', { name: 'older' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/repeated or omitted/));
    fireEvent.click(screen.getByRole('button', { name: 'older' }));
    expect(mocks.getGoalEvents.mock.calls.filter(([, options]) => options.beforeSequence === 20)).toHaveLength(1);
  });

  it('never commits a deferred load-older response after the authorization identity changes', async () => {
    let resolveOlder!: (value: GoalEventsPage) => void;
    mocks.getGoalEvents.mockImplementation((_goalId: string, options: { afterSequence?: number; beforeSequence?: number }) => {
      if (options.beforeSequence === 20) return new Promise(resolve => { resolveOlder = resolve; });
      if (options.afterSequence !== undefined) return Promise.resolve(page([]));
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

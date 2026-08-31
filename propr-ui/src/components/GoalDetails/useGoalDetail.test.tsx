import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  pauseGoal: mocks.pauseGoal, resumeGoal: vi.fn(), cancelGoal: vi.fn(), requestGoalModel: vi.fn(), sendGoalMessage: vi.fn(), cancelGoalMessage: vi.fn(),
}));

import { useGoalDetail } from './useGoalDetail';
import { GoalApiError } from '../../api/goalsApi';

const timestamp = '2026-08-31T10:00:00.000Z';
const user = (id: string): CurrentUser => ({ id, login: id, username: id, displayName: id, email: null, avatarUrl: null, role: 'member', permissions: [], authorizationSource: 'local' });
const event = (sequence: number): GoalEvent => ({ goalId: 'goal-1', sequence, type: 'stdout', source: 'codex', timestamp, turnId: 'turn-1', content: `line ${sequence}`, payload: null });
const page = (events: GoalEvent[], hasMoreBefore = false): GoalEventsPage => ({ events, hasMoreBefore, previousCursor: events[0]?.sequence ?? null, nextCursor: events.at(-1)?.sequence ?? null });
const detail: GoalDetail = {
  goal: { goalId: 'goal-1', objective: 'Operator goal', repository: 'integry/propr', state: 'running', agent: 'codex', requestedModel: 'gpt', effectiveModel: 'gpt', maxActiveTasks: 2, mergePolicy: 'manual', ultrafixEnabled: false, ultrafixGoal: null, ultrafixMaxCycles: null, version: 1, terminalReason: null, createdAt: timestamp, updatedAt: timestamp },
  hierarchy: { nodes: [], dependencies: [] }, providerTodos: [], messages: [],
  stats: { issues: { total: 0, active: 0, processed: 0, failed: 0, blocked: 0 }, pullRequests: { open: 0, reviewPending: 0, ultrafixPending: 0, mergeReady: 0, merged: 0 }, tokens: { total: 0, byModel: [] }, time: { elapsedSeconds: 0, activeSeconds: 0, pausedSeconds: 0, recoverySeconds: 0 } },
  recovery: { state: 'healthy', attempt: 0, reason: null }, epicPrUrl: null, completionBlockers: [], latestSequence: 5,
};

const Harness = () => {
  const goal = useGoalDetail('goal-1');
  return <><div data-testid="detail">{goal.detail?.goal.repository ?? 'empty'}</div><div data-testid="version">{goal.detail?.goal.version ?? 'none'}</div><div data-testid="events">{goal.events.map(item => item.sequence).join(',')}</div><div data-testid="connection">{goal.connectionState}</div><div role="alert">{goal.actionError}</div><button type="button" onClick={() => void goal.loadOlder()}>older</button><button type="button" onClick={() => void goal.pause()}>pause</button></>;
};

describe('useGoalDetail replay and authorization', () => {
  beforeEach(() => {
    mocks.user = user('owner-a'); mocks.connected = true; mocks.demo = false;
    mocks.socket.emit.mockClear(); mocks.socket.on.mockClear(); mocks.socket.off.mockClear(); mocks.listeners.clear();
    mocks.getGoal.mockReset().mockResolvedValue(detail);
    mocks.pauseGoal.mockReset().mockResolvedValue({ ...detail.goal, state: 'pausing', version: 2 });
    mocks.getInstanceCatalog.mockReset().mockResolvedValue({ agents: [], repositories: [], defaultAgentAlias: null });
    mocks.getGoalEvents.mockReset().mockImplementation((_goalId: string, options: { afterSequence?: number; beforeSequence?: number }) => {
      if (options.beforeSequence === 4) return Promise.resolve(page([event(3)], false));
      if (options.afterSequence !== undefined) return Promise.resolve(page([], false));
      return Promise.resolve(page([event(4), event(5)], true));
    });
  });

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
});

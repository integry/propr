import type { CurrentUser } from '../../api/proprTypes';
import type { GoalDetail, GoalEvent, GoalEventsPage } from '../../api/goalsApi';
import { useEffect } from 'react';
import { vi } from 'vitest';

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

export const getGoalDetailMocks = () => mocks;

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

const timestamp = '2026-08-31T10:00:00.000Z';
export const user = (id: string): CurrentUser => ({ id, login: id, username: id, displayName: id, email: null, avatarUrl: null, role: 'member', permissions: [], authorizationSource: 'local' });
export const event = (sequence: number, goalId = 'goal-1'): GoalEvent => ({ schemaVersion: 1, goalId, sequence, eventType: 'provider.output', kind: 'output', payload: { provider: 'codex', turnId: 'turn-1', stream: 'stdout', outputType: 'text', chunk: `line ${sequence}` }, createdAt: timestamp, cursor: `cursor:${sequence}` });
const opaque = (value: string | number | null): string | null => value === null ? null : typeof value === 'string' ? value : `cursor:${value}`;
export const cursorSequence = (value: string | undefined): number | undefined => value === undefined ? undefined : Number(value.slice(value.lastIndexOf(':') + 1));
export const page = (events: GoalEvent[], hasMoreBefore = false, previousCursor: string | number | null = events[0]?.cursor ?? null, nextCursor: string | number | null = events.length >= 200 ? events.at(-1)?.cursor ?? null : null): GoalEventsPage => ({ schemaVersion: 1, events, hasMoreBefore, previousCursor: opaque(previousCursor), nextCursor: opaque(nextCursor), asOfSequence: events.at(-1)?.sequence ?? 0 });
export const message = (body = 'alpha', messageId = 'message-1') => ({
  messageId, sequence: 10, body, cannedAction: null, state: 'delivered' as const,
  error: null, createdAt: timestamp, updatedAt: timestamp,
});
export const detail: GoalDetail = {
  goal: { goalId: 'goal-1', objective: 'Operator goal', repository: 'integry/propr', state: 'running', agent: 'codex', requestedModel: 'gpt', effectiveModel: 'gpt', maxActiveTasks: 2, mergePolicy: 'manual', ultrafixEnabled: false, ultrafixGoal: null, ultrafixMaxCycles: null, version: 1, terminalReason: null, createdAt: timestamp, updatedAt: timestamp },
  provider: { sessionId: 'session-1', generation: 1, eventSequence: 5, status: 'working', statusDetail: null, updatedAt: timestamp, checkpoint: null, capabilities: { nativeGoal: true, pause: { supported: true, application: 'safe_boundary' }, resume: { supported: true, application: 'immediate' }, steer: { supported: true, application: 'next_turn' }, modelChange: { supported: true, application: 'safe_boundary' } } },
  plan: { status: 'not-reported' }, messages: [],
  stats: { tokens: { total: 0, byProviderModel: [] }, time: { elapsedSeconds: 0, activeSeconds: 0, pausedSeconds: 0 }, messages: { queued: 0, oldestQueuedSeconds: null }, artifacts: { issues: { total: 0, open: 0, closed: 0 }, pullRequests: { total: 0, open: 0, merged: 0, draft: 0 }, finalPullRequest: null } },
  infrastructure: { recovery: { state: 'healthy', attempt: 0, reason: null }, warnings: [] }, latestSequence: 5, latestCursor: 'cursor:5',
};

export const createGoalDetailHarness = () => {
  function Harness({ goalId = 'goal-1', viewportAnchorSequence }: { goalId?: string; viewportAnchorSequence?: number }) {
    const goal = useGoalDetail(goalId);
    const setViewportAnchor = goal.setViewportAnchor;
    const retry = { ...message('retry me', 'failed-1'), state: 'failed' as const };
    useEffect(() => {
      setViewportAnchor(viewportAnchorSequence === undefined ? null : { sequence: viewportAnchorSequence, viewportOffset: 70 });
      return () => setViewportAnchor(null);
    }, [setViewportAnchor, viewportAnchorSequence]);
    return <><div data-testid="detail">{goal.detail?.goal.repository ?? 'empty'}</div><div data-testid="version">{goal.detail?.goal.version ?? 'none'}</div><div data-testid="state">{goal.detail?.goal.state ?? 'none'}</div><div data-testid="events">{goal.events.map(item => item.sequence).join(',')}</div><div data-testid="event-types">{goal.events.map(item => item.eventType).join(',')}</div><div data-testid="messages">{goal.detail?.messages.map(item => item.body).join(',') ?? ''}</div><div data-testid="tokens">{goal.detail?.stats.tokens.total ?? 0}</div><div data-testid="connection">{goal.connectionState}</div><div data-testid="readonly">{String(goal.readOnly)}</div><div data-testid="loading-older">{String(goal.loadingOlder)}</div><div data-testid="has-more-before">{String(goal.hasMoreBefore)}</div><div role="alert">{goal.actionError}</div><button type="button" disabled={goal.loadingOlder || !goal.hasMoreBefore} onClick={() => void goal.loadOlder()}>older</button><button type="button" onClick={() => void goal.pause()}>pause</button><button type="button" onClick={() => void goal.sendMessage({ body: 'alpha' })}>message alpha</button><button type="button" onClick={() => void goal.sendMessage({ body: 'beta' })}>message beta</button><button type="button" onClick={() => void goal.sendMessage({ cannedAction: 'whats_done' })}>message canned</button><button type="button" onClick={() => void goal.retryMessage(retry)}>retry failed</button></>;
  }
  return Harness;
};

export const resetGoalDetailMocks = () => {
  mocks.user = user('owner-a'); mocks.connected = true; mocks.demo = false;
  mocks.socket.emit.mockClear(); mocks.socket.on.mockClear(); mocks.socket.off.mockClear(); mocks.listeners.clear();
  mocks.getGoal.mockReset().mockResolvedValue(detail);
  mocks.pauseGoal.mockReset().mockResolvedValue({ ...detail.goal, state: 'pausing', version: 2 });
  mocks.sendGoalMessage.mockReset().mockImplementation((_goalId, params) => Promise.resolve(message(params.body ?? params.cannedAction)));
  mocks.cancelGoalMessage.mockReset();
  mocks.getInstanceCatalog.mockReset().mockResolvedValue({ agents: [], repositories: [], defaultAgentAlias: null });
  mocks.getGoalEvents.mockReset().mockImplementation((_goalId: string, options: { afterCursor?: string; beforeCursor?: string }) => {
    if (options.beforeCursor === 'cursor:4') return Promise.resolve(page([event(3)], false));
    if (options.afterCursor !== undefined) return Promise.resolve(page([], false));
    return Promise.resolve(page([event(4), event(5)], true));
  });
};

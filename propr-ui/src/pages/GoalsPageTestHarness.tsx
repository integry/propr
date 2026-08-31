import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { getGoals, type GoalListItem } from '../api/goalsApi';
import type { CurrentUser } from '../api/proprTypes';
import GoalsPageTestView from './GoalsPageTestView';

const mocks = vi.hoisted(() => ({
  demoMode: false,
  connected: true,
  goalUpdate: undefined as ((payload: { schemaVersion: 1; goalId: string; version: number; latestSequence: number; timestamp: string; eventType: 'goal:summary:update' }) => void) | undefined,
  onGoalSummaryUpdate: vi.fn(),
  subscribeToGoalUpdates: vi.fn(),
  unsubscribeFromGoalUpdates: vi.fn(),
  user: null as CurrentUser | null,
}));

export const getGoalsPageMocks = () => mocks;
export const getGoalsApiMock = () => vi.mocked(getGoals);

vi.mock('../api/goalsApi', async importOriginal => ({
  ...await importOriginal<typeof import('../api/goalsApi')>(),
  getGoals: vi.fn(),
}));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: mocks.demoMode }) }));
vi.mock('../contexts/AuthContext', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: mocks.connected,
    onGoalSummaryUpdate: mocks.onGoalSummaryUpdate,
    subscribeToGoalUpdates: mocks.subscribeToGoalUpdates,
    unsubscribeFromGoalUpdates: mocks.unsubscribeFromGoalUpdates,
  }),
}));

export const goal: GoalListItem = {
  goalId: 'goal-1', objective: 'Durable orchestration', repository: 'integry/propr', state: 'running', agent: 'codex',
  requestedModel: 'requested', effectiveModel: 'effective', maxActiveTasks: 3, mergePolicy: 'manual',
  ultrafixEnabled: false, ultrafixGoal: null, ultrafixMaxCycles: null, version: 2, nodeCount: 4,
  activeNodeCount: 1, latestSequence: 8, projection: { status: 'not-yet-projected' },
  createdAt: '2026-08-31T00:00:00Z', updatedAt: '2026-08-31T01:00:00Z',
};

export const user = (id: string, role: CurrentUser['role'] = 'member'): CurrentUser => ({
  id, login: id, username: id, displayName: id, email: null, avatarUrl: null,
  role, permissions: [], authorizationSource: 'local',
});

export function renderPage(entries: string[] = ['/goals'], initialIndex = entries.length - 1) {
  const makeView = () => <GoalsPageTestView entries={entries} initialIndex={initialIndex} />;
  const rendered = render(makeView());
  return { ...rendered, rerenderPage: () => rendered.rerender(makeView()) };
}

export const updatePayload = (version: number) => ({
  schemaVersion: 1 as const, eventType: 'goal:summary:update' as const, goalId: 'goal-1', version,
  latestSequence: version + 8, timestamp: '2026-08-31T02:00:00Z',
});

export const resetGoalsPageMocks = () => {
  vi.useRealTimers();
  mocks.demoMode = false; mocks.user = user('owner-a'); mocks.connected = true; mocks.goalUpdate = undefined;
  mocks.onGoalSummaryUpdate.mockReset().mockImplementation(callback => {
    mocks.goalUpdate = callback;
    return vi.fn();
  });
  mocks.subscribeToGoalUpdates.mockReset();
  mocks.unsubscribeFromGoalUpdates.mockReset();
  vi.mocked(getGoals).mockReset();
};

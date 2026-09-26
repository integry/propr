import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueStatsUpdatePayload } from '@propr/shared';
import Layout from './Layout';

let queueStatsCallback: ((payload: QueueStatsUpdatePayload) => void) | undefined;

vi.mock('../api/proprApi', () => ({ logout: vi.fn() }));
vi.mock('../hooks/useDynamicFavicon', () => ({ useDynamicFavicon: vi.fn() }));
vi.mock('../hooks/useSystemReadiness', () => ({
  useSystemReadiness: () => ({ hasAgents: true, hasRepos: true, hasTasks: true }),
}));
vi.mock('./ui/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false }) }));
vi.mock('../contexts/AuthContext', () => ({
  useCurrentUser: () => null,
  userHasPermission: () => false,
}));
vi.mock('../contexts/NotificationCenterContext', () => ({
  useNotificationCenter: () => ({ unreadCount: null }),
}));
vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: true,
    subscribeToQueueStats: vi.fn(),
    unsubscribeFromQueueStats: vi.fn(),
    subscribeToIndexingUpdates: vi.fn(),
    unsubscribeFromIndexingUpdates: vi.fn(),
    onQueueStatsUpdate: (callback: (payload: QueueStatsUpdatePayload) => void) => {
      queueStatsCallback = callback;
      return vi.fn();
    },
    onIndexingUpdate: () => vi.fn(),
    onDraftUpdate: () => vi.fn(),
  }),
}));
vi.mock('./GlobalHeader', () => ({ default: () => null }));
vi.mock('./AgentTankSidebar', () => ({ default: () => null }));
vi.mock('./ConnectPlusBanner', () => ({ ConnectCapacityBanner: () => null }));

describe('Layout sidebar counts', () => {
  beforeEach(() => {
    queueStatsCallback = undefined;
  });

  it('shows running goals separately from active tasks', () => {
    render(<MemoryRouter><Layout><div>Page</div></Layout></MemoryRouter>);

    act(() => queueStatsCallback?.({
      eventType: 'queue:stats:update',
      stats: { waiting: 0, active: 3, activeGoals: 2, completed: 0, failed: 0, delayed: 0, total: 3 },
      timestamp: '2026-09-03T23:30:00.000Z',
    }));

    expect(within(screen.getByRole('link', { name: /Goals/ })).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByRole('link', { name: /Tasks/ })).getByText('1')).toBeInTheDocument();
  });
});

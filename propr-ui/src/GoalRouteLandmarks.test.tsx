import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import AppRoutes from './AppRoutes';

vi.mock('./components/RouteChunkErrorBoundary', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('./components/GlobalHeader', () => ({ default: () => <header>Global header</header> }));
vi.mock('./components/AgentTankSidebar', () => ({ default: () => null }));
vi.mock('./components/ConnectPlusBanner', () => ({ ConnectCapacityBanner: () => null }));
vi.mock('./hooks/useDynamicFavicon', () => ({ useDynamicFavicon: vi.fn() }));
vi.mock('./hooks/useSystemReadiness', () => ({ useSystemReadiness: () => ({ hasAgents: true, hasRepos: true, hasTasks: true }) }));
vi.mock('./components/ui/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('./contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false, isLoading: false }) }));
vi.mock('./contexts/AuthContext', () => ({ useCurrentUser: () => null, userHasPermission: () => false }));
vi.mock('./contexts/NotificationCenterContext', () => ({ useNotificationCenter: () => ({ unreadCount: 0 }) }));
vi.mock('./contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: false,
    subscribeToQueueStats: vi.fn(), unsubscribeFromQueueStats: vi.fn(),
    subscribeToIndexingUpdates: vi.fn(), unsubscribeFromIndexingUpdates: vi.fn(),
    onQueueStatsUpdate: () => vi.fn(), onIndexingUpdate: () => vi.fn(), onDraftUpdate: () => vi.fn(),
  }),
}));
vi.mock('./api/proprApi', async importOriginal => ({
  ...await importOriginal<typeof import('./api/proprApi')>(),
  logout: vi.fn(),
}));

vi.mock('./pages/useGoalsList', () => ({
  useGoalsList: () => ({
    goals: [], loading: false, error: null, isConnected: true, searchQuery: '', stateFilter: 'all',
    repositoryFilter: '', appliedSearch: '', newGoalPath: '/goals/new', detailReturnTarget: '/goals',
    currentPage: 1, hasPrevious: false, hasNext: false,
    setSearchQuery: vi.fn(), setStateFilter: vi.fn(), clearSearch: vi.fn(), clearFilters: vi.fn(),
    nextPage: vi.fn(), previousPage: vi.fn(),
  }),
}));
vi.mock('./pages/useGoalCreateForm', () => ({
  useGoalCreateForm: () => ({ catalogLoading: true, catalogError: null, cancel: vi.fn() }),
}));
vi.mock('./components/GoalDetails/GoalControls', () => ({ default: () => <section>Controls</section> }));
vi.mock('./components/GoalDetails/GoalHierarchy', () => ({ default: () => <section>Hierarchy</section> }));
vi.mock('./components/GoalDetails/GoalStats', () => ({ default: () => <section>Statistics</section> }));
vi.mock('./components/GoalDetails/GoalTerminal', () => ({ default: () => <section>Terminal</section> }));
vi.mock('./components/GoalDetails/useGoalDetail', () => ({
  useGoalDetail: () => ({
    loading: false, error: null, actionError: null, connectionState: 'connected', events: [],
    hasMoreBefore: false, loadingOlder: false, loadOlder: vi.fn(), readOnly: false, pendingAction: null,
    goalModels: [], pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), changeModel: vi.fn(),
    sendMessage: vi.fn(), retryMessage: vi.fn(), cancelMessage: vi.fn(),
    detail: {
      goal: {
        goalId: 'goal-123', objective: 'One landmark goal', repository: 'integry/propr', state: 'running',
        agent: 'codex', requestedModel: 'gpt', effectiveModel: 'gpt', version: 1,
      },
      hierarchy: { nodes: [], dependencies: [] }, providerTodos: [],
      stats: {}, recovery: { state: 'healthy', attempt: 0, reason: null },
      epicPrUrl: null, completionBlockers: [],
    },
  }),
}));

describe('goal route landmarks', () => {
  it.each(['/goals', '/goals/new', '/goals/goal-123'])('composes %s through the real Layout with exactly one main', async path => {
    render(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>);
    expect(await screen.findAllByRole('main')).toHaveLength(1);
  });
});

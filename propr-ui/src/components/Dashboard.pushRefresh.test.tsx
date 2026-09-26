/**
 * The dashboard refreshes because something changed, not because time passed.
 *
 * Every assertion here is about cost: which pushed frame wakes which pane, how
 * many requests a burst of them is allowed to produce, and what an open console
 * costs while the instance is quiet. The panes used to share one token fed by
 * task events, so an agent's tool-call heartbeat re-ran the aggregate
 * completion-count query behind the historical stats panel — the single most
 * wasteful read on the page, and the reason each pane now declares its own
 * interest in the activity envelope.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Dashboard from './Dashboard';
import { SocketContext, type SocketContextValue } from '../contexts/SocketContext';
import {
  getDashboardActive,
  getDashboardAttention,
  getDashboardOutcomes,
  getDashboardStats,
} from '../api/dashboardApi';
import type { ActivityChange, ActivityDomain, ActivityUpdatePayload } from '@propr/shared';
import {
  activeItem,
  activeResponse,
  attentionItem,
  attentionResponse,
  outcomeItem,
  outcomesResponse,
  statsResponse,
} from './Dashboard.fixtures';

vi.mock('../api/dashboardApi', () => ({
  getDashboardAttention: vi.fn(),
  getDashboardActive: vi.fn(),
  getDashboardOutcomes: vi.fn(),
  getDashboardStats: vi.fn(),
}));

let socketConnected = true;
let activityHandler: ((payload: ActivityUpdatePayload) => void) | null = null;

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: socketConnected,
    subscribeToActivity: () => {},
    unsubscribeFromActivity: () => {},
    onGoalUpdate: () => () => {},
    onActivityUpdate: (handler: (payload: ActivityUpdatePayload) => void) => {
      activityHandler = handler;
      return () => {
        if (activityHandler === handler) activityHandler = null;
      };
    },
  }),
}));

vi.mock('../hooks/useSystemReadiness', () => ({
  useSystemReadiness: () => ({
    hasAgents: true,
    hasDefaultModel: true,
    hasRepos: true,
    hasTasks: true,
    isLoading: false,
  }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useCurrentUser: () => null,
  userHasPermission: () => false,
}));

vi.mock('./ConnectPlusBanner', () => ({ ConnectSoftPromoBanner: () => null }));
vi.mock('./AgentTankDetectionBanner', () => ({ default: () => null }));
// Recharts needs a measured container, which jsdom never provides.
vi.mock('./Dashboard/DailyCompletionsChart', () => ({ DailyCompletionsChart: () => null }));

vi.mock('../utils/repoHelpers', () => ({
  fetchEnabledRepos: vi.fn(async () => [
    { name: 'acme/app', enabled: true },
    { name: 'acme/web', enabled: true },
  ]),
}));

const mockAttention = vi.mocked(getDashboardAttention);
const mockActive = vi.mocked(getDashboardActive);
const mockOutcomes = vi.mocked(getDashboardOutcomes);
const mockStats = vi.mocked(getDashboardStats);

/** One pushed activity frame, in the envelope the server publishes. */
const activity = (
  domain: ActivityDomain,
  change: ActivityChange,
  overrides: Partial<ActivityUpdatePayload> = {},
): ActivityUpdatePayload => ({
  eventType: 'activity:update',
  domain,
  change,
  entityId: 'task-1',
  repository: 'acme/app',
  terminal: change === 'completed' || change === 'failed' || change === 'cancelled',
  occurredAt: new Date().toISOString(),
  ...overrides,
});

/** Delivers one frame in its own flush, so only coalescing can collapse a burst. */
async function push(payload: ActivityUpdatePayload): Promise<void> {
  await act(async () => {
    activityHandler?.(payload);
    await Promise.resolve();
  });
}

/*
  The sections read the connection from the context rather than through
  `useSocket`, so the provider is part of the tree under test: with it, an idle
  dashboard is genuinely idle, and without a connection every section falls back
  to its bounded poll.
*/
function renderDashboard(initialEntry = '/') {
  return render(
    <SocketContext.Provider value={{ isConnected: socketConnected } as unknown as SocketContextValue}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
        </Routes>
      </MemoryRouter>
    </SocketContext.Provider>,
  );
}

/** Every section has landed its first read. */
async function waitForSections() {
  await waitFor(() => expect(screen.getByTestId('happening-now-section')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId('historical-stats-section')).toBeInTheDocument());
}

describe('Dashboard push-driven refreshes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketConnected = true;
    activityHandler = null;
    mockAttention.mockResolvedValue(attentionResponse());
    mockActive.mockResolvedValue(activeResponse([activeItem()]));
    mockOutcomes.mockResolvedValue(outcomesResponse([outcomeItem()]));
    mockStats.mockResolvedValue(statsResponse());
  });

  it('does not re-read aggregate stats for progress-only activity', async () => {
    // The clock is held still for the burst, then stepped past one coalescing
    // window: on real timers a loaded machine can take longer than that window
    // to deliver five frames, which splits the burst across two windows and
    // makes the count of reads a race rather than a fact.
    vi.useFakeTimers();
    try {
      renderDashboard();
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(mockStats).toHaveBeenCalledTimes(1);

      // A tool-call heartbeat is the noisiest event on a busy instance. Re-running
      // the completion-count aggregate for it was the single most wasteful refresh
      // on the page; the stats panel only reacts to finished work.
      for (let index = 0; index < 5; index += 1) {
        await push(activity('task', 'progressed', { entityId: `task-${index}` }));
      }

      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(mockActive).toHaveBeenCalledTimes(2);
      expect(mockStats).toHaveBeenCalledTimes(1);
      // Progress is not a completion either, so the outcomes feed stays put.
      expect(mockOutcomes).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-reads outcomes and stats exactly once for a completion', async () => {
    renderDashboard();
    await waitForSections();
    await waitFor(() => expect(mockStats).toHaveBeenCalledTimes(1));

    await push(activity('task', 'completed'));

    await waitFor(() => expect(mockOutcomes).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockStats).toHaveBeenCalledTimes(2));
    expect(mockOutcomes).toHaveBeenCalledTimes(2);
    expect(mockStats).toHaveBeenCalledTimes(2);
  });

  it('shows a plan issue that moved to review without waiting for a timer', async () => {
    renderDashboard();
    await waitForSections();
    expect(screen.getByTestId('needs-attention-empty')).toBeInTheDocument();

    mockAttention.mockResolvedValue(attentionResponse([
      attentionItem({ id: 'plan-issue:5', kind: 'plan_review', category: 'decision', taskId: null, prNumber: 51, title: null }),
    ]));
    await push(activity('plan', 'blocked', { entityId: 'plan-issue:5' }));

    await waitFor(() => expect(mockAttention).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('link', { name: /Review pull request/ })).toBeInTheDocument();
  });

  it('issues no request for activity in another repository', async () => {
    renderDashboard('/?repository=acme%2Fapp');
    await waitForSections();
    const before = {
      attention: mockAttention.mock.calls.length,
      active: mockActive.mock.calls.length,
      outcomes: mockOutcomes.mock.calls.length,
      stats: mockStats.mock.calls.length,
    };

    await push(activity('task', 'completed', { entityId: 'task-elsewhere', repository: 'acme/web' }));

    // Filtered in the client before any request: discovering the event was
    // irrelevant must not cost a round trip.
    expect(mockAttention).toHaveBeenCalledTimes(before.attention);
    expect(mockActive).toHaveBeenCalledTimes(before.active);
    expect(mockOutcomes).toHaveBeenCalledTimes(before.outcomes);
    expect(mockStats).toHaveBeenCalledTimes(before.stats);
  });

  it('issues no request at all over an idle period while connected', async () => {
    const requestCount = () => mockAttention.mock.calls.length
      + mockActive.mock.calls.length
      + mockOutcomes.mock.calls.length
      + mockStats.mock.calls.length;

    vi.useFakeTimers();
    try {
      renderDashboard();
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      const initial = requestCount();
      expect(initial).toBe(4);

      // Two minutes of an open dashboard with nothing happening on the instance.
      // The cost of the page no longer scales with how long it stays open.
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(requestCount()).toBe(initial);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps every section fresh on the fallback interval while the socket is down', async () => {
    vi.useFakeTimers();
    try {
      socketConnected = false;
      renderDashboard();
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(mockActive).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(65_000); });

      // Push is the normal path; a client with no websocket degrades to the
      // previous behaviour rather than silently going stale.
      expect(mockAttention.mock.calls.length).toBeGreaterThan(1);
      expect(mockActive.mock.calls.length).toBeGreaterThan(1);
      expect(mockOutcomes.mock.calls.length).toBeGreaterThan(1);
      expect(mockStats.mock.calls.length).toBeGreaterThan(1);
      // The rows stay, and nothing on screen narrates the connection.
      expect(screen.getByText('Add retry budget')).toBeInTheDocument();
      expect(screen.queryByText(/Reconnecting|Last updated/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('issues no request while the tab is hidden, and reconciles once when it returns', async () => {
    renderDashboard();
    await waitForSections();
    await waitFor(() => expect(mockActive).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockStats).toHaveBeenCalledTimes(1));

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      await push(activity('task', 'completed'));

      // A backgrounded tab is not looking at the dashboard, so it does not pay
      // for it. The invalidation is remembered rather than dropped.
      expect(mockActive).toHaveBeenCalledTimes(1);
      expect(mockStats).toHaveBeenCalledTimes(1);
      expect(mockAttention).toHaveBeenCalledTimes(1);
      expect(mockOutcomes).toHaveBeenCalledTimes(1);

      visibility.mockReturnValue('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });

      // One reconcile per section, not one per event missed while hidden.
      await waitFor(() => expect(mockActive).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(mockStats).toHaveBeenCalledTimes(2));
      expect(mockAttention).toHaveBeenCalledTimes(2);
      expect(mockOutcomes).toHaveBeenCalledTimes(2);
    } finally {
      visibility.mockRestore();
    }
  });
});

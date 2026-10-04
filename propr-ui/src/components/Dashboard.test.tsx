import { getUsageTips, dismissUsageTip } from '../api/usageTipsApi';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Dashboard from './Dashboard';
import { SocketContext, type SocketContextValue } from '../contexts/SocketContext';
import { NeedsAttentionPanel } from './Dashboard/NeedsAttentionPanel';
import { SUMMARY_COALESCE_MS } from './Dashboard/useDashboardSummary';
import {
  getDashboardNarrative, getDashboardActive, getDashboardAttention, getDashboardOutcomes, getDashboardStats,
} from '../api/dashboardApi';
// The envelope these frames imitate is the one `activityEvents` declares:
// `entityId` and a resolved `terminal`, which is what the server publishes.
import type { ActivityChange, ActivityDomain, ActivityUpdatePayload } from '@propr/shared/dist/activityEvents.js';
import {
  activeItem, activeResponse, attentionItem, attentionResponse, outcomeItem, outcomesResponse, statsResponse,
} from './Dashboard.fixtures';

vi.mock('../api/usageTipsApi', () => ({ getUsageTips: vi.fn(async () => ({ enabled: true, tips: [] })), dismissUsageTip: vi.fn(), USAGE_TIPS_SETTINGS_CHANGED: 'tips-settings-changed' }));

vi.mock('../api/dashboardApi', () => ({
  getDashboardNarrative: vi.fn(), getDashboardAttention: vi.fn(), getDashboardActive: vi.fn(),
  getDashboardOutcomes: vi.fn(), getDashboardStats: vi.fn(),
}));

let socketConnected = true;
let activityHandler: ((payload: ActivityUpdatePayload) => void) | null = null;

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: socketConnected,
    subscribeToActivity: () => {}, unsubscribeFromActivity: () => {}, onGoalUpdate: () => () => {},
    onActivityUpdate: (handler: (payload: ActivityUpdatePayload) => void) => {
      activityHandler = handler;
      return () => { if (activityHandler === handler) activityHandler = null; };
    },
  }),
}));

/** One pushed activity frame, in the envelope the server publishes. */
const activity = (domain: ActivityDomain, change: ActivityChange, overrides: Partial<ActivityUpdatePayload> = {}): ActivityUpdatePayload => ({
  eventType: 'activity:update', domain, change, entityId: 'task-1', repository: 'acme/app',
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

vi.mock('../hooks/useSystemReadiness', () => ({
  useSystemReadiness: () => ({ hasAgents: true, hasDefaultModel: true, hasRepos: true, hasTasks: true, isLoading: false }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useCurrentUser: () => null, userHasPermission: () => false,
}));

vi.mock('./ConnectPlusBanner', () => ({ ConnectSoftPromoBanner: () => null }));
vi.mock('./AgentTankDetectionBanner', () => ({ default: () => null }));
// Recharts needs a measured container, which jsdom never provides.
vi.mock('./Dashboard/DailyCompletionsChart', () => ({ DailyCompletionsChart: () => null }));

vi.mock('../utils/repoHelpers', () => ({
  fetchEnabledRepos: vi.fn(async () => [{ name: 'acme/app', enabled: true }, { name: 'acme/web', enabled: true }]),
}));

const mockAttention = vi.mocked(getDashboardAttention);
const mockActive = vi.mocked(getDashboardActive);
const mockOutcomes = vi.mocked(getDashboardOutcomes);
const mockStats = vi.mocked(getDashboardStats);

function expectSectionReads(count: number) {
  for (const read of [mockAttention, mockActive, mockOutcomes, mockStats]) expect(read).toHaveBeenCalledTimes(count);
}

/**
 * The two things "Happening now" can say when it has no rows.
 *
 * They are named here so the test can assert they are genuinely different
 * strings: "nothing is running" and "we could not find out" are different
 * facts, and a refactor that collapsed them into one message would otherwise
 * still satisfy a pair of `toHaveTextContent` assertions.
 */
const IDLE_RUNNING_MESSAGE = 'No active tasks or goals running';
const UNAVAILABLE_RUNNING_MESSAGE = 'Unable to load running work';

const LocationProbe: React.FC = () => {
  const location = useLocation();
  return <span data-testid="location-search">{location.search}</span>;
};

/*
  The sections read the connection from the context rather than through
  `useSocket`, so the provider is part of the tree under test: with it, an idle
  dashboard is genuinely idle, and without a connection every section falls back
  to its bounded poll.
*/
function dashboardTree(initialEntry = '/') {
  return (
    <SocketContext.Provider value={{ isConnected: socketConnected } as unknown as SocketContextValue}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
        <Routes><Route path="/" element={<Dashboard />} /></Routes>
      </MemoryRouter>
    </SocketContext.Provider>
  );
}

function renderAttentionPanel() {
  return render(<MemoryRouter><NeedsAttentionPanel repository="all" refreshToken={0} /></MemoryRouter>);
}

/** Every section has landed its first read. */
async function waitForSections() {
  await waitFor(() => expect(screen.getByTestId('happening-now-section')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId('historical-stats-section')).toBeInTheDocument());
}

async function renderLoadedDashboard(initialEntry = '/') {
  const view = render(dashboardTree(initialEntry));
  await waitForSections();
  return view;
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDashboardNarrative).mockResolvedValue({ repository: 'all', enabled: true, summary: 'Work is underway. Nothing needs your attention.' });
    socketConnected = true;
    activityHandler = null;
    mockAttention.mockResolvedValue(attentionResponse());
    mockActive.mockResolvedValue(activeResponse([activeItem()]));
    mockOutcomes.mockResolvedValue(outcomesResponse([outcomeItem()]));
    mockStats.mockResolvedValue(statsResponse());
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('shows running goals beside tasks and links to the scoped goal list and goal details', async () => {
    mockActive.mockResolvedValue(activeResponse([
      activeItem({ id: 'goal:goal-1', goalId: 'goal-1', taskId: 'goal-task-1', taskType: 'goal',
        title: 'Improve dashboard reliability', issueNumber: null, prNumber: null,
        progressLine: 'Checking dashboard tests' }),
      activeItem(),
    ]));
    await renderLoadedDashboard('/?repository=acme%2Fweb');
    const section = within(screen.getByTestId('happening-now-section'));
    expect(section.getByText('Goal')).toBeInTheDocument();
    expect(section.getByRole('link', { name: /Improve dashboard reliability/ })).toHaveAttribute('href', '/goals/goal-1');
    expect(section.getByRole('link', { name: 'View goals' })).toHaveAttribute('href', '/goals?status=running&repository=acme%2Fweb');
    expect(section.getByRole('link', { name: 'View tasks' })).toHaveAttribute('href', '/tasks?status=active&repository=acme%2Fweb');
    expect(section.getAllByText('Checking dashboard tests').length).toBeGreaterThan(0);
  });

  it('defers all four initial section reads in a background tab', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const view = render(dashboardTree());
    try {
      await act(async () => { await Promise.resolve(); });
      expectSectionReads(0);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      fireEvent(document, new Event('visibilitychange'));
      await waitForSections();
      await waitFor(() => expectSectionReads(1));
    } finally {
      view.unmount();
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    }
  });

  it('keeps the attention section in place with an all-clear line when nothing needs attention', async () => {
    await renderLoadedDashboard();

    // The section is structure, not a conditional decoration: unmounting it
    // collapsed the right column and left the stats panel alone at the top of
    // a rail of white space.
    const panel = screen.getByTestId('needs-attention-panel');
    expect(panel).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Needs attention/ })).toHaveTextContent('Needs attention (0)');
    expect(screen.getByTestId('needs-attention-empty')).toHaveTextContent('All tasks operational — no attention required');
    // Nothing to view, so no "View all" link into an empty list.
    expect(within(panel).queryByRole('link', { name: 'View all' })).not.toBeInTheDocument();
  });

  it('expands all seven attention items and collapses them with an accurate footer', async () => {
    mockAttention.mockResolvedValue(attentionResponse(Array.from({ length: 7 }, (_, index) =>
      attentionItem({ id: `attention-${index}`, title: `Blocked work ${index}` }))));
    renderAttentionPanel();
    const panel = screen.getByTestId('needs-attention-panel');
    const more = await within(panel).findByRole('button', { name: 'Show 4 more' });
    expect(within(panel).getByRole('heading')).toHaveTextContent('Needs attention (7)');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(more);
    expect(within(panel).getAllByRole('listitem')).toHaveLength(7);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(panel).getByRole('button', { name: 'Show fewer' }));
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3);
  });

  it('keeps old waits relative and flags only waits over fourteen days as stale', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    mockAttention.mockResolvedValue(attentionResponse([50, 14, 15].map(days =>
      attentionItem({ id: `age-${days}`, since: new Date(now - days * 86_400_000).toISOString() }))));
    renderAttentionPanel();
    const panel = screen.getByTestId('needs-attention-panel');
    await within(panel).findByText('Waiting 50d');
    expect(within(panel).getAllByText('Stale')).toHaveLength(2);
    expect(within(panel).getByText('Waiting 14d').parentElement).not.toHaveTextContent('Stale');
    expect(panel).not.toHaveTextContent(/Waiting \d+\/\d+\//);
  });

  it('expands typed chronological deltas, preserving findings, scores and destinations', async () => {
    const earlierUpdates = [
      outcomeItem({ id: 'deferred', taskId: 'deferred', title: 'Followup: Ship the retry budget', taskType: 'review', detail: 'Review deferred: awaiting checks', score: null }),
      outcomeItem({ id: 'fix', taskId: 'fix', taskType: 'fix', title: 'Review PR #100: Ship the retry budget', detail: 'Implemented the requested changes:\n · Fixed operator markup · Validation: ESLint passed', score: null }),
      outcomeItem({ id: 'review', taskId: 'review', taskType: 'review', detail: '2 issues found: Allow repairable quotes; Preserve OpenCode attribution', score: 6 }),
      outcomeItem({ id: 'verify', taskId: 'verify', title: 'Followup: Ship the retry budget', taskType: 'pr-comment', detail: 'The reported lint issue is already fixed. No further changes were needed. · Verified: Lint passed', score: null }),
      outcomeItem({ id: 'ci', taskId: 'ci', taskType: 'ci', detail: 'Build passed', score: null }),
      outcomeItem({ id: 'ultrafix', taskId: 'ultrafix', title: 'Ultrafix PR #100: Ship the retry budget', detail: 'Implemented delimiter repair · Validation: Tests passed', score: null }),
      outcomeItem({ id: 'no-recap', taskId: 'no-recap', title: 'Fix PR #100: Ship the retry budget', detail: 'Ship the retry budget' }),
    ];
    mockOutcomes.mockResolvedValue(outcomesResponse([outcomeItem({ eventCount: 8, earlierUpdates })]));
    await renderLoadedDashboard();
    const list = await screen.findByTestId('completed-list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).queryByText('Fixed operator markup')).toBeNull();
    const toggle = within(list).getByRole('button', { name: '7 earlier updates' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle.closest('a')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const updates = within(document.getElementById(toggle.getAttribute('aria-controls')!)!);
    expect(updates.getAllByTestId('work-type-badge').map(badge => badge.textContent))
      .toEqual(['Review', 'Fix', 'Review', 'Verify', 'CI', 'Ultrafix', 'Fix']);
    expect(updates.getByText('Allow repairable quotes & Preserve OpenCode attribution (2 issues)'))
      .toHaveAttribute('title', earlierUpdates[2].detail);
    expect(updates.getByText('Implemented the requested changes: · Fixed operator markup · Validation: ESLint passed')).toBeVisible();
    expect(updates.getByText('Review score 6 out of 10')).toBeInTheDocument();
    expect(updates.getByText('Review deferred: awaiting checks')).toBeVisible();
    expect(updates.getByText('Fix run')).toBeVisible();
    expect(updates.getAllByRole('link').map(link => link.getAttribute('href')))
      .toEqual(earlierUpdates.map(update => `/tasks/${update.taskId}`));
    fireEvent.click(toggle);
    expect(within(list).queryByText('Fixed operator markup')).toBeNull();
  });

  it('shows five parent outcomes before offering more', async () => {
    mockOutcomes.mockResolvedValue(outcomesResponse(Array.from({ length: 7 }, (_, index) =>
      outcomeItem({ id: `parent-${index}`, taskId: `parent-${index}`, prNumber: 100 + index }))));
    await renderLoadedDashboard();
    const list = await screen.findByTestId('completed-list');
    expect(list.children).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(list.children).toHaveLength(7);
  });

  it('omits redundant review tags while preserving standard task types', async () => {
    mockAttention.mockResolvedValue(attentionResponse([
      attentionItem({ id: 'review', kind: 'plan_review', taskType: null, title: 'New Issue: Add VERSION constant' }),
      attentionItem({ id: 'fix', kind: 'task_failed', taskType: 'pr-comment', title: 'Fix PR #12: Repair validation' }),
    ]));
    renderAttentionPanel();
    const badges = await within(screen.getByTestId('needs-attention-panel')).findAllByTestId('work-type-badge');
    expect(badges.map(badge => badge.textContent)).toEqual(['Fix']);
  });

  it('draws the attention heading before its first read lands, so the column never jumps', async () => {
    let resolveAttention: (value: ReturnType<typeof attentionResponse>) => void = () => {};
    mockAttention.mockReturnValue(new Promise(resolve => { resolveAttention = resolve; }));

    renderAttentionPanel();

    // A skeleton under the real heading, not instead of the whole section.
    expect(screen.getByTestId('needs-attention-panel')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
    expect(screen.getByTestId('section-skeleton')).toBeInTheDocument();
    // No count until there is one to report: "(0)" while loading would claim
    // the panel had looked and found nothing.
    expect(screen.getByRole('heading', { name: 'Needs attention' })).not.toHaveTextContent('(0)');

    resolveAttention(attentionResponse([attentionItem()]));
    await screen.findByText('Checkout retries never fire');
    expect(screen.getByRole('heading', { name: /Needs attention/ })).toHaveTextContent('Needs attention (1)');
  });

  it('keeps the heading and offers a retry when the attention read fails', async () => {
    mockAttention.mockRejectedValue(new Error('attention unavailable'));
    renderAttentionPanel();

    await waitFor(() => expect(screen.getByText('Unable to load what needs attention')).toBeInTheDocument());
    // "We could not find out" is not "there is nothing to do".
    expect(screen.getByTestId('needs-attention-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('needs-attention-empty')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs attention' })).not.toHaveTextContent('(0)');
  });

  it('counts and lists attention items when work is blocked', async () => {
    mockAttention.mockResolvedValue(attentionResponse([
      attentionItem(),
      attentionItem({ id: 'plan-issue:5', kind: 'plan_review', category: 'decision', taskId: null, prNumber: 51, title: null }),
    ]));

    await renderLoadedDashboard();

    expect(screen.getByRole('heading', { name: /Needs attention/ })).toHaveTextContent('Needs attention (2)');
    const panel = screen.getByTestId('needs-attention-panel');
    expect(panel).toHaveTextContent('Run failed');
    expect(panel).toHaveTextContent('Checkout retries never fire');
    expect(panel).toHaveTextContent('Waiting 3 hrs');
    expect(screen.getByRole('link', { name: /Review pull request/ })).toHaveAttribute('href', 'https://github.com/acme/app/pull/51');
    expect(screen.queryByTestId('needs-attention-empty')).not.toBeInTheDocument();
  });

  it('applies one repository filter to every section and writes it to the URL', async () => {
    await renderLoadedDashboard();

    fireEvent.click(screen.getByRole('button', { name: /All Repos/ }));
    fireEvent.click(screen.getAllByTestId('repo-item').find(item => item.textContent?.includes('web')) as HTMLElement);

    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('repository=acme%2Fweb'));
    await waitFor(() => {
      expect(mockAttention).toHaveBeenLastCalledWith('acme/web');
      expect(mockActive).toHaveBeenLastCalledWith('acme/web');
      expect(mockOutcomes).toHaveBeenLastCalledWith('acme/web', 50, '');
      expect(mockStats).toHaveBeenLastCalledWith('acme/web', '7d');
    });
    // The filtered lists behind the pane links carry the same filter.
    const running = screen.getByTestId('happening-now-section');
    expect(within(running).getByRole('link', { name: 'View all' })).toHaveAttribute('href', '/tasks?status=active&repository=acme%2Fweb');
  });

  it('coalesces terminal and attention events per section and narrative without refetching or dismissing tips', async () => {
    // The clock is held still for the burst. Each frame is still delivered in
    // its own flush, so only the scheduler's coalescing can collapse them —
    // but on real timers a loaded machine can spend longer than the coalescing
    // window delivering ten frames, which splits one burst into two windows and
    // costs a second read. That is correct behaviour and a broken assertion, so
    // the window is stepped explicitly instead of raced against.
    vi.useFakeTimers();
    render(dashboardTree());
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByTestId('historical-stats-section')).toBeInTheDocument();
    expect(mockActive).toHaveBeenCalledTimes(1);
    expect(activityHandler).not.toBeNull();
    expect(getDashboardNarrative).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 10; index += 1) {
      const change = (['completed', 'failed', 'cancelled', 'blocked'] as const)[index % 4];
      await push(activity('task', change, { entityId: `task-${index}` }));
    }
    // Still inside the window: the burst has cost nothing yet.
    expect(mockActive).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expectSectionReads(2);

    // And nothing trails in behind the coalesced read.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expectSectionReads(2);
    expect(getDashboardNarrative).toHaveBeenCalledTimes(2);
    expect(getUsageTips).toHaveBeenCalledTimes(1);
    expect(dismissUsageTip).not.toHaveBeenCalled();
  });

  it('restores the URL repository filter and ignores progress or completions outside it for narrative', async () => {
    // A second section read is not proof here: the sections coalesce in a
    // shorter window than the summary, so the summary's own window is what has
    // to be outlasted before "it never read again" means anything.
    vi.useFakeTimers();
    render(dashboardTree('/?repository=acme/app'));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(getDashboardNarrative).toHaveBeenCalledTimes(1);

    expect(mockAttention).toHaveBeenCalledWith('acme/app');
    expect(mockActive).toHaveBeenCalledWith('acme/app');
    expect(mockStats).toHaveBeenCalledWith('acme/app', '7d');

    await push(activity('task', 'progressed', { entityId: 'progress' }));
    await push(activity('task', 'completed', { entityId: 'outside', repository: 'acme/web' }));

    await act(async () => { await vi.advanceTimersByTimeAsync(SUMMARY_COALESCE_MS * 4); });
    expect(getDashboardNarrative).toHaveBeenCalledTimes(1);
  });

  it('does not reorder running work under a pointer when live updates arrive', async () => {
    const first = activeItem({ id: 'task:a', taskId: 'a', title: 'Alpha work' });
    const second = activeItem({ id: 'task:b', taskId: 'b', title: 'Beta work' });
    mockActive.mockResolvedValue(activeResponse([first, second]));

    await renderLoadedDashboard();
    await waitFor(() => expect(screen.getByText('Alpha work')).toBeInTheDocument());

    // Every row is a link to its work, so the row under the pointer is the
    // thing that must not move between the press and the release.
    const rows = within(screen.getByTestId('happening-now-list')).getAllByRole('link');
    fireEvent.mouseOver(rows[0]);

    // The server now reports the rows the other way round.
    mockActive.mockResolvedValue(activeResponse([second, first]));
    await push(activity('task', 'progressed', { entityId: 'b' }));
    await waitFor(() => expect(mockActive).toHaveBeenCalledTimes(2));

    const titles = screen.getAllByText(/(Alpha|Beta) work/).map(node => /(Alpha|Beta) work/.exec(node.textContent ?? '')?.[0]);
    expect(titles).toEqual(['Alpha work', 'Beta work']);
  });

  it('keeps the last known rows, and says nothing about the socket, when it drops', async () => {
    const { rerender } = await renderLoadedDashboard();
    await waitFor(() => expect(screen.getByText('Add retry budget')).toBeInTheDocument());

    socketConnected = false;
    rerender(dashboardTree());

    // The rows are the report. A dropped socket never blanks the dashboard,
    // and it no longer narrates itself across the top of the page either.
    expect(screen.getByText('Add retry budget')).toBeInTheDocument();
    expect(screen.queryByTestId('live-status')).toBeNull();
    expect(screen.queryByText(/Reconnecting|Last updated/)).toBeNull();
  });

  it.each([
    { state: 'idle', message: IDLE_RUNNING_MESSAGE, absent: UNAVAILABLE_RUNNING_MESSAGE, retries: 0 },
    { state: 'unavailable', message: UNAVAILABLE_RUNNING_MESSAGE, absent: IDLE_RUNNING_MESSAGE, retries: 1 },
  ])('distinguishes $state running work and offers only appropriate actions', async ({ state, message, absent, retries }) => {
    // An empty list is normal operation; a failed read must offer a retry.
    if (state === 'idle') mockActive.mockResolvedValue(activeResponse([]));
    else mockActive.mockRejectedValue(new Error('network down'));
    await renderLoadedDashboard();
    const panel = screen.getByTestId('happening-now-section');
    await within(panel).findByText(message);
    expect(panel).not.toHaveTextContent(absent);
    expect(within(panel).queryByRole('link', { name: 'View all' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: 'Retry' })).toHaveLength(retries);
    if (retries) {
      mockActive.mockResolvedValue(activeResponse([activeItem()]));
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await screen.findByText('Add retry budget');
    }
  });

  it('renders an unknown success rate as unavailable rather than zero', async () => {
    mockStats.mockResolvedValue(statsResponse({
      successRate: null, recordedSpend: null,
      previous: { completed: 0, successRate: null, recordedSpend: null },
    }));

    await renderLoadedDashboard();

    await waitFor(() => expect(screen.getByTestId('stat-success-rate')).toHaveTextContent('—'));
    expect(screen.getByTestId('stat-success-rate')).not.toHaveTextContent('0%');
    expect(screen.getByTestId('stat-spend')).toHaveTextContent('—');
    // One word per metric: a label that truncates to `RECORDED SP…` in a
    // three-column grid reads as a broken grid, so the qualification moved to
    // the tooltip.
    const spendLabel = screen.getByTestId('historical-stats-section').querySelector('[title^="Recorded spend"]');
    expect(spendLabel).toHaveTextContent('Spend');
  });

  it('summarises the queue with the reason work is waiting', async () => {
    mockActive.mockResolvedValue(activeResponse([activeItem()], [activeItem({ id: 'task:q', taskId: 'q', state: 'pending', phase: 'Waiting' })]));

    await renderLoadedDashboard();

    const queue = await screen.findByTestId('queue-summary');
    expect(queue).toHaveTextContent('1 queued');
    expect(queue).toHaveTextContent('All agents are busy');
  });

  it('shows a review score as the quality pill and omits the element entirely without one', async () => {
    mockOutcomes.mockResolvedValue(outcomesResponse([
      outcomeItem({ id: 'scored', title: 'Review PR #100: Ship the retry budget', taskType: 'pr-comment', score: 8, detail: '2 issues found: Missing test; Leaky timer' }),
      outcomeItem({ id: 'unscored', taskId: 'done-2', title: 'No score here' }),
    ]));

    await renderLoadedDashboard();

    const scores = await screen.findAllByTestId('completed-score');
    expect(scores).toHaveLength(1);
    expect(scores[0]).toHaveTextContent('8');
    // The scale reaches assistive technology without being drawn on screen.
    expect(scores[0]).toHaveTextContent('Review score 8 out of 10');
    expect(scores[0].textContent).not.toMatch(/\/10/);
    // What the review found is the row's detail line.
    expect(screen.getByText('2 issues found: Missing test; Leaky timer')).toBeInTheDocument();
  });

  it('titles the completed feed "Completed" and never repeats the state on its rows', async () => {
    mockOutcomes.mockResolvedValue(outcomesResponse([
      outcomeItem({ id: 'a', title: 'Fix PR #2494: [Epic] MCP operator surface', taskType: 'pr-comment' }),
    ]));

    await renderLoadedDashboard();

    const feed = await screen.findByTestId('completed-section');
    expect(within(feed).getByRole('heading', { name: 'Completed' })).toBeInTheDocument();
    const list = await within(feed).findByTestId('completed-list');
    expect(list).not.toHaveTextContent(/Completed/);
    expect(within(feed).queryByRole('group', { name: 'Outcome window' })).toBeNull();
    expect(within(list).getByTestId('work-type-badge')).toHaveTextContent('Fix');
    expect(list).toHaveTextContent('[Epic] MCP operator surface');
    expect(list).not.toHaveTextContent('Fix PR #2494');
  });

  it('filters completed work by title through the heading search box', async () => {
    await renderLoadedDashboard();
    await waitFor(() => expect(mockOutcomes).toHaveBeenCalledWith('all', 50, ''));

    mockOutcomes.mockResolvedValue(outcomesResponse([outcomeItem({ id: 'hit', title: 'Cache repository icons' })]));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter completed work by title' }), { target: { value: ' icons ' } });

    await waitFor(() => expect(mockOutcomes).toHaveBeenCalledWith('all', 50, 'icons'));
    expect(await screen.findByText('Cache repository icons')).toBeInTheDocument();
  });
});

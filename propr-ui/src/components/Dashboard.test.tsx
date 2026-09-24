import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Dashboard from './Dashboard';
import { NeedsAttentionPanel } from './Dashboard/NeedsAttentionPanel';
import {
  getDashboardActive,
  getDashboardAttention,
  getDashboardOutcomes,
  getDashboardStats,
} from '../api/dashboardApi';
import type { TaskUpdatePayload } from '@propr/shared';
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
let taskUpdateHandler: ((payload: TaskUpdatePayload) => void) | null = null;

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: socketConnected,
    onTaskUpdate: (handler: (payload: TaskUpdatePayload) => void) => {
      taskUpdateHandler = handler;
      return () => {
        if (taskUpdateHandler === handler) taskUpdateHandler = null;
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

/**
 * The two things "Happening now" can say when it has no rows.
 *
 * They are named here so the test can assert they are genuinely different
 * strings: "nothing is running" and "we could not find out" are different
 * facts, and a refactor that collapsed them into one message would otherwise
 * still satisfy a pair of `toHaveTextContent` assertions.
 */
const IDLE_RUNNING_MESSAGE = 'No work running';
const UNAVAILABLE_RUNNING_MESSAGE = 'Unable to load running work';

const LocationProbe: React.FC = () => {
  const location = useLocation();
  return <span data-testid="location-search">{location.search}</span>;
};

function renderDashboard(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route path="/" element={<Dashboard />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Every section has landed its first read. */
async function waitForSections() {
  await waitFor(() => expect(screen.getByTestId('happening-now-section')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId('historical-stats-section')).toBeInTheDocument());
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketConnected = true;
    taskUpdateHandler = null;
    mockAttention.mockResolvedValue(attentionResponse());
    mockActive.mockResolvedValue(activeResponse([activeItem()]));
    mockOutcomes.mockResolvedValue(outcomesResponse([outcomeItem()]));
    mockStats.mockResolvedValue(statsResponse());
  });

  it('keeps the attention section in place with an all-clear line when nothing needs attention', async () => {
    renderDashboard();
    await waitForSections();

    // The section is structure, not a conditional decoration: unmounting it
    // collapsed the right column and left the stats panel alone at the top of
    // a rail of white space.
    const panel = screen.getByTestId('needs-attention-panel');
    expect(panel).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Needs attention/ })).toHaveTextContent('Needs attention (0)');
    expect(screen.getByTestId('needs-attention-empty')).toHaveTextContent(
      'All tasks operational — no attention required',
    );
    // Nothing to view, so no "View all" link into an empty list.
    expect(within(panel).queryByRole('link', { name: 'View all' })).not.toBeInTheDocument();
  });

  it('draws the attention heading before its first read lands, so the column never jumps', async () => {
    let resolveAttention: (value: ReturnType<typeof attentionResponse>) => void = () => {};
    mockAttention.mockReturnValue(new Promise(resolve => { resolveAttention = resolve; }));

    render(
      <MemoryRouter>
        <NeedsAttentionPanel repository="all" refreshToken={0} />
      </MemoryRouter>,
    );

    // A skeleton under the real heading, not instead of the whole section.
    expect(screen.getByTestId('needs-attention-panel')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
    expect(screen.getByTestId('section-skeleton')).toBeInTheDocument();
    // No count until there is one to report: "(0)" while loading would claim
    // the panel had looked and found nothing.
    expect(screen.getByRole('heading', { name: 'Needs attention' })).not.toHaveTextContent('(0)');

    resolveAttention(attentionResponse([]));
    await waitFor(() => expect(screen.getByTestId('needs-attention-empty')).toBeInTheDocument());
  });

  it('keeps the heading and offers a retry when the attention read fails', async () => {
    mockAttention.mockRejectedValue(new Error('attention unavailable'));
    render(
      <MemoryRouter>
        <NeedsAttentionPanel repository="all" refreshToken={0} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Unable to load what needs attention')).toBeInTheDocument());
    // "We could not find out" is not "there is nothing to do".
    expect(screen.getByTestId('needs-attention-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('needs-attention-empty')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs attention' })).not.toHaveTextContent('(0)');
  });

  it('shows the attention list whatever the caller asked for when work is blocked', async () => {
    mockAttention.mockResolvedValue(attentionResponse([attentionItem()]));
    render(
      <MemoryRouter>
        <NeedsAttentionPanel repository="all" refreshToken={0} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('needs-attention-panel')).toBeInTheDocument());
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByTestId('needs-attention-panel')).toHaveTextContent('Checkout retries never fire');
  });

  it('counts and lists attention items when work is blocked', async () => {
    mockAttention.mockResolvedValue(attentionResponse([
      attentionItem(),
      attentionItem({ id: 'plan-issue:5', kind: 'plan_review', category: 'decision', taskId: null, prNumber: 51, title: null }),
    ]));

    renderDashboard();
    await waitForSections();

    expect(screen.getByRole('heading', { name: /Needs attention/ })).toHaveTextContent('Needs attention (2)');
    const panel = screen.getByTestId('needs-attention-panel');
    expect(panel).toHaveTextContent('Run failed');
    expect(panel).toHaveTextContent('Checkout retries never fire');
    expect(panel).toHaveTextContent('Waiting 3 hrs');
    expect(screen.getByRole('link', { name: /Review pull request/ })).toHaveAttribute(
      'href',
      'https://github.com/acme/app/pull/51',
    );
    expect(screen.queryByTestId('needs-attention-empty')).not.toBeInTheDocument();
  });

  it('applies one repository filter to every section and writes it to the URL', async () => {
    renderDashboard();
    await waitForSections();

    fireEvent.click(screen.getByRole('button', { name: /All Repos/ }));
    fireEvent.click(screen.getAllByTestId('repo-item').find(item => item.textContent?.includes('web')) as HTMLElement);

    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('repository=acme%2Fweb'));
    await waitFor(() => {
      expect(mockAttention).toHaveBeenLastCalledWith('acme/web');
      expect(mockActive).toHaveBeenLastCalledWith('acme/web');
      expect(mockOutcomes).toHaveBeenLastCalledWith('acme/web', 50);
      expect(mockStats).toHaveBeenLastCalledWith('acme/web', '7d');
    });
    // The filtered lists behind the pane links carry the same filter.
    const running = screen.getByTestId('happening-now-section');
    expect(within(running).getByRole('link', { name: 'View all' })).toHaveAttribute('href', '/tasks?status=active&repository=acme%2Fweb');
  });

  it('restores the repository filter from the URL on load', async () => {
    renderDashboard('/?repository=acme%2Fapp');
    await waitForSections();

    expect(mockAttention).toHaveBeenCalledWith('acme/app');
    expect(mockActive).toHaveBeenCalledWith('acme/app');
    expect(mockStats).toHaveBeenCalledWith('acme/app', '7d');
  });

  it('coalesces a burst of task updates into a single refresh per section', async () => {
    renderDashboard();
    await waitForSections();

    await waitFor(() => expect(mockActive).toHaveBeenCalledTimes(1));
    expect(taskUpdateHandler).not.toBeNull();

    // Each event is delivered in its own flush, so only the scheduler's
    // coalescing can collapse them into one read per section.
    for (let index = 0; index < 10; index += 1) {
      await act(async () => {
        taskUpdateHandler?.({
          taskId: `task-${index}`,
          state: 'claude_execution',
          repository: 'acme/app',
        } as TaskUpdatePayload);
        await Promise.resolve();
      });
    }

    await waitFor(() => expect(mockActive).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockStats).toHaveBeenCalledTimes(2));
    expect(mockAttention).toHaveBeenCalledTimes(2);
    expect(mockOutcomes).toHaveBeenCalledTimes(2);
  });

  it('does not reorder running work under a pointer when live updates arrive', async () => {
    const first = activeItem({ id: 'task:a', taskId: 'a', title: 'Alpha work' });
    const second = activeItem({ id: 'task:b', taskId: 'b', title: 'Beta work' });
    mockActive.mockResolvedValue(activeResponse([first, second]));

    renderDashboard();
    await waitForSections();
    await waitFor(() => expect(screen.getByText('Alpha work')).toBeInTheDocument());

    // Every row is a link to its work, so the row under the pointer is the
    // thing that must not move between the press and the release.
    const rows = within(screen.getByTestId('happening-now-list')).getAllByRole('link');
    fireEvent.mouseOver(rows[0]);

    // The server now reports the rows the other way round.
    mockActive.mockResolvedValue(activeResponse([second, first]));
    await act(async () => {
      taskUpdateHandler?.({ taskId: 'b', state: 'post_processing', repository: 'acme/app' } as TaskUpdatePayload);
    });
    await waitFor(() => expect(mockActive).toHaveBeenCalledTimes(2));

    const titles = screen.getAllByText(/(Alpha|Beta) work/).map(node => node.textContent);
    expect(titles).toEqual(['Alpha work', 'Beta work']);
  });

  it('keeps the last known rows, and says nothing about the socket, when it drops', async () => {
    const { rerender } = renderDashboard();
    await waitForSections();
    await waitFor(() => expect(screen.getByText('Add retry budget')).toBeInTheDocument());

    socketConnected = false;
    rerender(
      <MemoryRouter initialEntries={['/']}>
        <LocationProbe />
        <Routes>
          <Route path="/" element={<Dashboard />} />
        </Routes>
      </MemoryRouter>,
    );

    // The rows are the report. A dropped socket never blanks the dashboard,
    // and it no longer narrates itself across the top of the page either.
    expect(screen.getByText('Add retry budget')).toBeInTheDocument();
    expect(screen.queryByTestId('live-status')).toBeNull();
    expect(screen.queryByText(/Reconnecting|Last updated/)).toBeNull();
  });

  it('distinguishes no running work from a failed read of running work', async () => {
    // The point of the section: the idle line and the unavailable line are not
    // the same sentence, and neither one is reachable in the other's state.
    expect(IDLE_RUNNING_MESSAGE).not.toBe(UNAVAILABLE_RUNNING_MESSAGE);

    mockActive.mockResolvedValue(activeResponse([]));
    const empty = renderDashboard();
    await waitForSections();
    expect(screen.getByTestId('happening-now-section')).toHaveTextContent(IDLE_RUNNING_MESSAGE);
    expect(screen.getByTestId('happening-now-section')).not.toHaveTextContent(UNAVAILABLE_RUNNING_MESSAGE);
    // An empty list is normal operation, so it never offers a retry.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    empty.unmount();

    mockActive.mockRejectedValue(new Error('network down'));
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByTestId('happening-now-section')).toHaveTextContent(UNAVAILABLE_RUNNING_MESSAGE),
    );
    expect(screen.getByTestId('happening-now-section')).not.toHaveTextContent(IDLE_RUNNING_MESSAGE);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('retries a failed running-work read on request', async () => {
    mockActive.mockRejectedValueOnce(new Error('network down'));
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByTestId('happening-now-section')).toHaveTextContent('Unable to load running work'),
    );

    mockActive.mockResolvedValue(activeResponse([activeItem()]));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Add retry budget')).toBeInTheDocument());
  });

  it('renders an unknown success rate as unavailable rather than zero', async () => {
    mockStats.mockResolvedValue(statsResponse({
      successRate: null,
      recordedSpend: null,
      previous: { completed: 0, successRate: null, recordedSpend: null },
    }));

    renderDashboard();
    await waitForSections();

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

    renderDashboard();
    await waitForSections();

    const queue = await screen.findByTestId('queue-summary');
    expect(queue).toHaveTextContent('1 queued');
    expect(queue).toHaveTextContent('All agents are busy');
  });

  it('shows a recorded score as the quality pill and omits the element entirely without one', async () => {
    mockOutcomes.mockResolvedValue(outcomesResponse([
      outcomeItem({ id: 'scored', score: 8 }),
      outcomeItem({ id: 'unscored', taskId: 'done-2', title: 'No score here' }),
    ]));

    renderDashboard();
    await waitForSections();

    const scores = await screen.findAllByTestId('outcome-score');
    expect(scores).toHaveLength(1);
    expect(scores[0]).toHaveTextContent('8');
    // The scale reaches assistive technology without being drawn on screen.
    expect(scores[0]).toHaveTextContent('Code quality score 8 out of 10');
    expect(scores[0].textContent).not.toMatch(/\/10/);
  });
});

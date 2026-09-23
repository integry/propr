import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Dashboard from './Dashboard';
import {
  getDashboardActive,
  getDashboardAttention,
  getDashboardOutcomes,
  getDashboardStats,
  getDashboardSummary,
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
  summaryResponse,
} from './Dashboard.fixtures';

vi.mock('../api/dashboardApi', () => ({
  getDashboardSummary: vi.fn(),
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

const mockSummary = vi.mocked(getDashboardSummary);
const mockAttention = vi.mocked(getDashboardAttention);
const mockActive = vi.mocked(getDashboardActive);
const mockOutcomes = vi.mocked(getDashboardOutcomes);
const mockStats = vi.mocked(getDashboardStats);

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
    mockSummary.mockResolvedValue(summaryResponse());
    mockAttention.mockResolvedValue(attentionResponse());
    mockActive.mockResolvedValue(activeResponse([activeItem()]));
    mockOutcomes.mockResolvedValue(outcomesResponse([outcomeItem()]));
    mockStats.mockResolvedValue(statsResponse());
  });

  it('drops the attention panel entirely when nothing needs attention, keeping a quiet line for mobile', async () => {
    renderDashboard();
    await waitForSections();

    expect(screen.queryByTestId('needs-attention-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('needs-attention-empty')).toHaveTextContent('Nothing needs your attention');
    expect(screen.getByTestId('summary-needs-attention')).toHaveAttribute('data-emphasis', 'false');
  });

  it('emphasises the attention count and lists attention items when work is blocked', async () => {
    mockSummary.mockResolvedValue(summaryResponse({ needsAttention: 2 }));
    mockAttention.mockResolvedValue(attentionResponse([
      attentionItem(),
      attentionItem({ id: 'plan-issue:5', kind: 'plan_review', category: 'decision', taskId: null, prNumber: 51, title: null }),
    ]));

    renderDashboard();
    await waitForSections();

    expect(screen.getByTestId('summary-needs-attention')).toHaveAttribute('data-emphasis', 'true');
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

  it('opens the correspondingly filtered list from each summary count', async () => {
    renderDashboard();
    await waitForSections();

    expect(screen.getByTestId('summary-needs-attention')).toHaveAttribute('href', '/tasks?status=attention');
    expect(screen.getByTestId('summary-running')).toHaveAttribute('href', '/tasks?status=active');
    expect(screen.getByTestId('summary-queued')).toHaveAttribute('href', '/tasks?status=waiting');
    expect(screen.getByTestId('summary-completed')).toHaveAttribute('href', '/tasks?status=completed');
  });

  it('applies one repository filter to every section and writes it to the URL', async () => {
    renderDashboard();
    await waitForSections();

    fireEvent.click(screen.getByRole('button', { name: /All Repos/ }));
    fireEvent.click(screen.getAllByTestId('repo-item').find(item => item.textContent?.includes('web')) as HTMLElement);

    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('repository=acme%2Fweb'));
    await waitFor(() => {
      expect(mockSummary).toHaveBeenLastCalledWith('acme/web');
      expect(mockAttention).toHaveBeenLastCalledWith('acme/web');
      expect(mockActive).toHaveBeenLastCalledWith('acme/web');
      expect(mockOutcomes).toHaveBeenLastCalledWith('acme/web', 50);
      expect(mockStats).toHaveBeenLastCalledWith('acme/web', '7d');
    });
    // The filtered lists behind the counts carry the same filter.
    expect(screen.getByTestId('summary-running')).toHaveAttribute('href', '/tasks?status=active&repository=acme%2Fweb');
  });

  it('restores the repository filter from the URL on load', async () => {
    renderDashboard('/?repository=acme%2Fapp');
    await waitForSections();

    expect(mockSummary).toHaveBeenCalledWith('acme/app');
    expect(mockActive).toHaveBeenCalledWith('acme/app');
    expect(mockStats).toHaveBeenCalledWith('acme/app', '7d');
  });

  it('coalesces a burst of task updates into a single refresh per section', async () => {
    renderDashboard();
    await waitForSections();

    await waitFor(() => expect(mockSummary).toHaveBeenCalledTimes(1));
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

    await waitFor(() => expect(mockSummary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockStats).toHaveBeenCalledTimes(2));
    expect(mockAttention).toHaveBeenCalledTimes(2);
    expect(mockActive).toHaveBeenCalledTimes(2);
    expect(mockOutcomes).toHaveBeenCalledTimes(2);
  });

  it('does not reorder running work while a row is expanded', async () => {
    const first = activeItem({ id: 'task:a', taskId: 'a', title: 'Alpha work' });
    const second = activeItem({ id: 'task:b', taskId: 'b', title: 'Beta work' });
    mockActive.mockResolvedValue(activeResponse([first, second]));

    renderDashboard();
    await waitForSections();
    await waitFor(() => expect(screen.getByText('Alpha work')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Expand Alpha work/ }));
    expect(screen.getByRole('button', { name: /Collapse Alpha work/ })).toBeInTheDocument();

    // The server now reports the rows the other way round.
    mockActive.mockResolvedValue(activeResponse([second, first]));
    await act(async () => {
      taskUpdateHandler?.({ taskId: 'b', state: 'post_processing', repository: 'acme/app' } as TaskUpdatePayload);
    });
    await waitFor(() => expect(mockActive).toHaveBeenCalledTimes(2));

    const titles = screen.getAllByText(/(Alpha|Beta) work/).map(node => node.textContent);
    expect(titles).toEqual(['Alpha work', 'Beta work']);
  });

  it('keeps the last known rows and reports reconnecting when the socket drops', async () => {
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

    await waitFor(() => expect(screen.getByTestId('live-status')).toHaveTextContent(/Reconnecting · Last updated/));
    expect(screen.getByText('Add retry budget')).toBeInTheDocument();
  });

  it('distinguishes no running work from a failed read of running work', async () => {
    mockActive.mockResolvedValue(activeResponse([]));
    const empty = renderDashboard();
    await waitForSections();
    expect(screen.getByTestId('happening-now-section')).toHaveTextContent('No work running');
    expect(screen.getByTestId('happening-now-section')).not.toHaveTextContent('Unable to load running work');
    empty.unmount();

    mockActive.mockRejectedValue(new Error('network down'));
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByTestId('happening-now-section')).toHaveTextContent('Unable to load running work'),
    );
    expect(screen.getByTestId('happening-now-section')).not.toHaveTextContent('No work running');
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
    expect(screen.getByTestId('historical-stats-section')).toHaveTextContent('Recorded spend');
  });

  it('summarises the queue with the reason work is waiting', async () => {
    mockActive.mockResolvedValue(activeResponse([activeItem()], [activeItem({ id: 'task:q', taskId: 'q', state: 'pending', phase: 'Waiting' })]));

    renderDashboard();
    await waitForSections();

    const queue = await screen.findByTestId('queue-summary');
    expect(queue).toHaveTextContent('1 queued');
    expect(queue).toHaveTextContent('All agents are busy');
  });

  it('shows a recorded score with its scale and omits the element entirely without one', async () => {
    mockOutcomes.mockResolvedValue(outcomesResponse([
      outcomeItem({ id: 'scored', score: 8 }),
      outcomeItem({ id: 'unscored', taskId: 'done-2', title: 'No score here' }),
    ]));

    renderDashboard();
    await waitForSections();

    const scores = await screen.findAllByTestId('outcome-score');
    expect(scores).toHaveLength(1);
    expect(scores[0]).toHaveTextContent('8');
    expect(scores[0]).toHaveTextContent('/10');
  });
});

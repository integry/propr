import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { HeaderScopeSlotContext } from '../components/headerScopeSlot';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AnalyticsPage from './AnalyticsPage';
import { getRepositoryStats, getStatsOverview, getTaskStats } from '../api/taskStatsApi';

vi.mock('../api/taskStatsApi', () => ({
  getTaskStats: vi.fn(),
  getRepositoryStats: vi.fn(),
  getStatsOverview: vi.fn(),
}));
vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({ isConnected: false, onTaskUpdate: () => () => {} }),
}));

type TaskStats = Awaited<ReturnType<typeof getTaskStats>>;
type RepositoryStats = Awaited<ReturnType<typeof getRepositoryStats>>;
type Overview = Awaited<ReturnType<typeof getStatsOverview>>;

const overview = {
  tasks: { completed: 7, planned: 0, pr_iterations_avg: 1, merged_prs: 7, total_followups: 1 },
  usage: { total_tokens: 4_200_000, input_tokens: 3_150_000, output_tokens: 1_050_000, total_cost_usd: 12.42, models: { 'claude-opus-5-5': 5, 'gpt-5.6': 3 } },
  model_usage: [
    { model: 'claude-opus-5-5', tasks: 5, tokens: 3_100_000, cost_usd: 9.4 },
    { model: 'gpt-5.6', tasks: 3, tokens: 1_100_000, cost_usd: 3.02 },
  ],
  system: { repos_indexed: 2 },
} as Overview;

const taskStats = {
  dailyCounts: [],
  statusDistribution: [],
  avgProcessingTime: [],
  summary: { total: 0, completed: 0, failed: 0 },
} as unknown as TaskStats;

const repositoryStats = (repository: string): RepositoryStats => ({
  repositories: [{ repository, total: 3, completed: 3, failed: 0, inProgress: 0, successRate: 100 }],
});

const LocationProbe = () => {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
};

const renderPage = (path = '/analytics') => render(
  <MemoryRouter initialEntries={[path]}>
    <AnalyticsPage />
    <LocationProbe />
  </MemoryRouter>,
);

describe('AnalyticsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStatsOverview).mockReturnValue(new Promise(() => {}));
  });

  it('announces the widgets waiting once for the page, not once per widget', async () => {
    let resolveTaskStats: (value: TaskStats) => void = () => {};
    let resolveRepositories: (value: RepositoryStats) => void = () => {};
    let resolveOverview: (value: Overview) => void = () => {};
    vi.mocked(getTaskStats).mockReturnValue(new Promise(resolve => { resolveTaskStats = resolve; }));
    vi.mocked(getRepositoryStats).mockReturnValue(new Promise(resolve => { resolveRepositories = resolve; }));
    vi.mocked(getStatsOverview).mockReturnValue(new Promise(resolve => { resolveOverview = resolve; }));

    renderPage();

    const pageStatus = screen.getByTestId('page-loading-status');
    await waitFor(() => expect(pageStatus).toHaveTextContent('Loading analytics…'));
    expect(screen.getAllByRole('status')).toEqual([pageStatus]);
    expect(screen.queryByText('Loading activity…')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading task status…')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading top repositories…')).not.toBeInTheDocument();

    await act(async () => { resolveTaskStats(taskStats); });
    expect(pageStatus).toHaveTextContent('Loading analytics…');

    await act(async () => { resolveRepositories({ repositories: [] } as unknown as RepositoryStats); });
    expect(pageStatus).toHaveTextContent('Loading analytics…');

    await act(async () => { resolveOverview(overview); });
    await waitFor(() => expect(pageStatus).toBeEmptyDOMElement());
  });

  it('lays the page out as one console: a totals band over a split pane, with no cards', async () => {
    vi.mocked(getTaskStats).mockResolvedValue({
      ...taskStats,
      dailyCounts: [{ date: '2026-09-30', count: 4 }, { date: '2026-10-01', count: 2 }],
      statusDistribution: [{ status: 'completed', count: 21 }, { status: 'failed', count: 3 }],
      summary: { total: 30, completed: 21, failed: 3 },
    } as TaskStats);
    vi.mocked(getRepositoryStats).mockResolvedValue({ repositories: [
      { repository: 'example/workspace', total: 20, completed: 17, failed: 2, inProgress: 1, successRate: 85 },
      { repository: 'example/docs', total: 10, completed: 4, failed: 1, inProgress: 5, successRate: 40 },
    ] });
    vi.mocked(getStatsOverview).mockResolvedValue(overview);

    const { container } = renderPage();

    expect(await screen.findByTestId('metric-total-tasks')).toHaveTextContent('30');
    expect(screen.getByTestId('metric-success-rate')).toHaveTextContent('87.5%');
    await waitFor(() => expect(screen.getByTestId('metric-tokens')).toHaveTextContent('4.2M'));
    expect(screen.getByTestId('metric-spend')).toHaveTextContent('$12.42');

    const primary = screen.getByTestId('analytics-primary-pane');
    const secondary = screen.getByTestId('analytics-secondary-pane');
    expect(within(primary).getByRole('heading', { name: /Activity · Last 30 days/ })).toBeInTheDocument();
    expect(within(primary).getByRole('heading', { name: /Repository performance/ })).toBeInTheDocument();
    expect(within(secondary).getByRole('heading', { name: 'Models' })).toBeInTheDocument();
    expect(within(secondary).getByRole('heading', { name: 'Task status' })).toBeInTheDocument();
    expect(within(secondary).getByRole('heading', { name: 'Token consumption' })).toBeInTheDocument();
    expect(screen.getByTestId('analytics-split').className).toContain('lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]');
    expect(primary).toHaveClass('lg:border-r', 'lg:border-slate-200');

    // Repositories are monospace code chips, without their owner.
    const chip = await within(primary).findByText('workspace');
    expect(chip).toHaveClass('font-mono', 'text-[12px]', 'bg-slate-100', 'border', 'border-slate-200');
    expect(chip).toHaveAttribute('title', 'example/workspace');

    // A catalogue model and an id the catalogue does not know read the same way.
    const models = within(secondary).getByTestId('model-breakdown-table');
    const modelRows = within(models).getAllByRole('row').slice(1).map(row => row.textContent);
    expect(modelRows).toEqual(['Claude Opus 5.553.1M$9.40', 'GPT-5.631.1M$3.02']);

    // The right pane accounts for the period's tokens: prompt against completion, and their price.
    const tokens = within(secondary).getByTestId('token-consumption');
    expect(within(tokens).getByTestId('token-row-input')).toHaveTextContent('Input · prompt3.2M75%');
    expect(within(tokens).getByTestId('token-row-output')).toHaveTextContent('Output · completion1.1M25%');
    expect(within(tokens).getByTestId('token-row-per-million')).toHaveTextContent('Spend per 1M tokens$2.96');

    // No floating cards: nothing on the canvas is a rounded, shadowed box.
    expect(container.querySelector('.shadow-sm, .rounded-xl')).toBeNull();
  });

  it('shows the repository scope read-only in the toolbar slot', () => {
    vi.mocked(getTaskStats).mockReturnValue(new Promise(() => {}));
    vi.mocked(getRepositoryStats).mockReturnValue(new Promise(() => {}));
    const slot = document.createElement('div');
    document.body.appendChild(slot);

    render(
      <MemoryRouter initialEntries={['/analytics']}>
        <HeaderScopeSlotContext.Provider value={slot}>
          <AnalyticsPage />
        </HeaderScopeSlotContext.Provider>
      </MemoryRouter>,
    );

    const scope = within(slot).getByTestId('analytics-repository-scope');
    expect(scope).toHaveTextContent('All Repos');
    expect(scope).toHaveAccessibleName('Repository scope: All Repos (locked)');
    expect(within(slot).queryByRole('button')).toBeNull();
    slot.remove();
  });

  it('offers six timeframes and scopes every section to the last 30 days by default', async () => {
    vi.mocked(getTaskStats).mockResolvedValue(taskStats);
    vi.mocked(getRepositoryStats).mockResolvedValue({ repositories: [] });

    renderPage();

    const group = screen.getByRole('group', { name: 'Analytics timeframe' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map(button => button.textContent)).toEqual(['24h', '7d', '30d', '90d', '1y', 'All']);
    expect(within(group).getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(buttons.filter(button => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1);

    const select = screen.getByRole('combobox', { name: 'Analytics timeframe' });
    expect(select).toHaveValue('30d');
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual([
      'Last 24 hours', 'Last 7 days', 'Last 30 days', 'Last 90 days', 'Last 12 months', 'All time',
    ]);

    // The subtitle never echoes the period: the pressed button and the activity heading carry it.
    expect(screen.getByTestId('analytics-timeframe-summary')).toHaveTextContent(/^Aggregate activity across all repositories$/);
    expect(screen.getByRole('heading', { name: /Activity · Last 30 days/ })).toBeInTheDocument();
    await waitFor(() => expect(getTaskStats).toHaveBeenCalledWith('30d'));
    expect(getRepositoryStats).toHaveBeenCalledWith('30d');
    expect(getStatsOverview).toHaveBeenCalledWith('30d');
  });

  it('re-fetches every section for a new timeframe and records it in the URL', async () => {
    vi.mocked(getTaskStats).mockResolvedValue(taskStats);
    vi.mocked(getRepositoryStats).mockResolvedValue({ repositories: [] });

    renderPage();
    await waitFor(() => expect(getTaskStats).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));

    await waitFor(() => expect(getTaskStats).toHaveBeenLastCalledWith('7d'));
    expect(getTaskStats).toHaveBeenCalledTimes(2);
    expect(getRepositoryStats).toHaveBeenLastCalledWith('7d');
    expect(getRepositoryStats).toHaveBeenCalledTimes(2);
    expect(getStatsOverview).toHaveBeenLastCalledWith('7d');
    expect(getStatsOverview).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('location')).toHaveTextContent('/analytics?period=7d');
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: /Activity · Last 7 days/ })).toBeInTheDocument();
    expect(screen.getByTestId('analytics-timeframe-summary')).toHaveTextContent(/^Aggregate activity across all repositories$/);

    fireEvent.change(screen.getByRole('combobox', { name: 'Analytics timeframe' }), { target: { value: '30d' } });
    await waitFor(() => expect(getTaskStats).toHaveBeenLastCalledWith('30d'));
    // The default is never written to the URL.
    expect(screen.getByTestId('location').textContent).toBe('/analytics');
  });

  it('restores the timeframe from the URL and ignores an unknown one', async () => {
    vi.mocked(getTaskStats).mockResolvedValue(taskStats);
    vi.mocked(getRepositoryStats).mockResolvedValue({ repositories: [] });

    const { unmount } = renderPage('/analytics?period=7d');
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(getTaskStats).toHaveBeenCalledWith('7d'));
    unmount();
    vi.clearAllMocks();
    vi.mocked(getStatsOverview).mockReturnValue(new Promise(() => {}));

    renderPage('/analytics?period=bogus');
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: /Activity · Last 30 days/ })).toBeInTheDocument();
    await waitFor(() => expect(getTaskStats).toHaveBeenCalledWith('30d'));
    expect(getRepositoryStats).toHaveBeenCalledWith('30d');
  });

  it('shows skeletons for a new timeframe and never lets a slow old response overwrite it', async () => {
    const pendingRepositories: Record<string, (value: RepositoryStats) => void> = {};
    vi.mocked(getTaskStats).mockResolvedValue(taskStats);
    vi.mocked(getRepositoryStats).mockImplementation(period => new Promise(resolve => {
      pendingRepositories[period ?? 'none'] = resolve;
    }));

    renderPage();
    await waitFor(() => expect(pendingRepositories['30d']).toBeDefined());
    await act(async () => { pendingRepositories['30d'](repositoryStats('acme/thirty-days')); });
    expect(await screen.findByText('thirty-days')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Last 24 hours' }));
    // The previous timeframe's rows are cleared while the new one loads.
    expect(screen.queryByText('thirty-days')).not.toBeInTheDocument();
    await waitFor(() => expect(pendingRepositories['24h']).toBeDefined());
    expect(screen.getByTestId('page-loading-status')).toHaveTextContent('Loading analytics…');

    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(pendingRepositories['7d']).toBeDefined());

    await act(async () => { pendingRepositories['7d'](repositoryStats('acme/seven-days')); });
    expect(await screen.findByText('seven-days')).toBeInTheDocument();
    // The slower 24-hour read lands last and is dropped.
    await act(async () => { pendingRepositories['24h'](repositoryStats('acme/one-day')); });
    expect(screen.queryByText('one-day')).not.toBeInTheDocument();
    expect(screen.getByText('seven-days')).toBeInTheDocument();
  });
});

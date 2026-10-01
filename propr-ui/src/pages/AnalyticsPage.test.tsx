import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
    vi.mocked(getTaskStats).mockReturnValue(new Promise(resolve => { resolveTaskStats = resolve; }));
    vi.mocked(getRepositoryStats).mockReturnValue(new Promise(resolve => { resolveRepositories = resolve; }));

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
    await waitFor(() => expect(pageStatus).toBeEmptyDOMElement());
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

    expect(screen.getByTestId('analytics-timeframe-summary')).toHaveTextContent('Aggregate activity across every repository · Last 30 days');
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
    expect(screen.getByTestId('analytics-timeframe-summary')).toHaveTextContent('· Last 7 days');

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
    expect(screen.getByTestId('analytics-timeframe-summary')).toHaveTextContent('· Last 30 days');
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

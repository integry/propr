import { act, render, screen, waitFor } from '@testing-library/react';
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

const taskStats = {
  dailyCounts: [],
  statusDistribution: [],
  avgProcessingTime: [],
  summary: { total: 0, completed: 0, failed: 0 },
} as unknown as Awaited<ReturnType<typeof getTaskStats>>;

describe('AnalyticsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStatsOverview).mockReturnValue(new Promise(() => {}));
  });

  it('announces the widgets waiting once for the page, not once per widget', async () => {
    let resolveTaskStats: (value: typeof taskStats) => void = () => {};
    let resolveRepositories: (value: Awaited<ReturnType<typeof getRepositoryStats>>) => void = () => {};
    vi.mocked(getTaskStats).mockReturnValue(new Promise(resolve => { resolveTaskStats = resolve; }));
    vi.mocked(getRepositoryStats).mockReturnValue(new Promise(resolve => { resolveRepositories = resolve; }));

    render(<AnalyticsPage />);

    const pageStatus = screen.getByTestId('page-loading-status');
    await waitFor(() => expect(pageStatus).toHaveTextContent('Loading analytics…'));
    expect(screen.getAllByRole('status')).toEqual([pageStatus]);
    expect(screen.queryByText('Loading activity…')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading task status…')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading top repositories…')).not.toBeInTheDocument();

    await act(async () => { resolveTaskStats(taskStats); });
    expect(pageStatus).toHaveTextContent('Loading analytics…');

    await act(async () => { resolveRepositories({ repositories: [] } as unknown as Awaited<ReturnType<typeof getRepositoryStats>>); });
    await waitFor(() => expect(pageStatus).toBeEmptyDOMElement());
  });
});

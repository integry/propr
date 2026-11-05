import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentTankHistory, getAgentTankUsage, refreshAgentTank } from '../../api/revertApi';
import type { AgentTankHistoryResponse, AgentTankUsageResponse } from '../../api/revertApi';
import AgentTankSidebar from '../AgentTankSidebar';
import { DemoModeContext } from '../../contexts/DemoModeContext';
import { HOVER_OPEN_DELAY_MS, UsageMetricHistoryTrigger } from './UsageMetricHistoryOverlay';
import { resetUsageMetricHistoryCache } from './useUsageMetricHistory';
import { currentPeriodStart, parseResetCountdown } from './usageHistoryModel';

vi.mock('../../api/revertApi', () => ({
  getAgentTankUsage: vi.fn(),
  refreshAgentTank: vi.fn(),
  getAgentTankHistory: vi.fn(),
}));

const usageListeners = vi.hoisted(() => new Set<() => void>());
vi.mock('../../contexts/useSocket', () => {
  const socket = () => ({
    isConnected: true,
    onActivityUpdate: () => () => undefined,
    onNotificationUpdate: () => () => undefined,
    onUsageUpdate: (listener: () => void) => {
      usageListeners.add(listener);
      return () => { usageListeners.delete(listener); };
    },
  });
  return { useSocket: socket, useOptionalSocket: socket };
});

const HOUR = 3_600_000;
const mockUsage = vi.mocked(getAgentTankUsage);
const mockHistory = vi.mocked(getAgentTankHistory);

const usage = (): AgentTankUsageResponse => ({
  enabled: true,
  agents: {
    claude: {
      name: 'claude',
      usage: {
        session: { percent: 17, resetsIn: '2h 14m' },
        weeklyAll: { percent: 58, resetsIn: '3d 4h' },
      },
    },
    antigravity: {
      name: 'antigravity',
      usage: {
        models: [
          { model: 'Gemini 4 Argon Weekly Limit', group: 'Gemini 4 Argon', cycle: 'weekly', percentUsed: 30, resetsIn: '96h 2m' },
        ],
      },
    },
  },
});

function history(agent: string, key: string, percents: number[]): AgentTankHistoryResponse {
  const now = Date.now();
  return {
    enabled: true,
    source: 'propr',
    agents: [{
      agent,
      series: [{
        key, label: key, model: null, cycle: 'session',
        points: percents.map((percent, index) => ({ t: new Date(now - (percents.length - index) * HOUR).toISOString(), percent })),
      }],
    }],
  };
}

beforeAll(() => {
  // jsdom has neither a layout observer for recharts nor PointerEvent.pointerType.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  if (!('PointerEvent' in window)) {
    class PointerEventPolyfill extends MouseEvent {
      pointerType: string;
      constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? 'mouse';
      }
    }
    Object.assign(window, { PointerEvent: PointerEventPolyfill });
  }
});

beforeEach(() => {
  window.localStorage.clear();
  resetUsageMetricHistoryCache();
  mockUsage.mockResolvedValue(usage());
  vi.mocked(refreshAgentTank).mockResolvedValue({ success: true });
  mockHistory.mockImplementation(async query => history(query.agents?.[0] ?? '', query.metric ?? '', [5, 12, 17]));
});

afterEach(() => {
  vi.clearAllMocks();
});

async function expandProvider(name: RegExp): Promise<void> {
  await screen.findByText('Usage');
  fireEvent.click(screen.getByRole('button', { name }));
}

function metricRow(label: string): HTMLElement {
  return screen.getByText(label).closest('[aria-haspopup="dialog"]') as HTMLElement;
}

describe('sidebar usage history overlay', () => {
  it('opens on hover after the intent delay and reads the last two sessions', async () => {
    render(<AgentTankSidebar />);
    await expandProvider(/^Claude/);
    const row = metricRow('Session');

    fireEvent.pointerEnter(row, { pointerType: 'mouse' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockHistory).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog', {}, { timeout: HOVER_OPEN_DELAY_MS + 1000 });
    expect(dialog).toHaveAccessibleName('Claude · Session usage history');
    expect(dialog).toHaveTextContent('Last 10 hours');
    expect(dialog).toHaveTextContent('17%');
    expect(row).toHaveAttribute('aria-expanded', 'true');

    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(1));
    const query = mockHistory.mock.calls[0][0];
    expect(query).toMatchObject({ agents: ['claude'], metric: 'session' });
    expect((query.until ?? 0) - query.since).toBe(10 * HOUR);
    expect(await screen.findByTestId('usage-metric-history-chart')).toBeInTheDocument();
  });

  it('does not open when the pointer passes over the row', async () => {
    render(<AgentTankSidebar />);
    await expandProvider(/^Claude/);
    const row = metricRow('Session');

    fireEvent.pointerEnter(row, { pointerType: 'mouse' });
    fireEvent.pointerLeave(row, { pointerType: 'mouse' });
    await new Promise(resolve => setTimeout(resolve, HOVER_OPEN_DELAY_MS + 50));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockHistory).not.toHaveBeenCalled();
  });

  it('reads two weeks for a weekly limit, toggled by tap', async () => {
    render(<AgentTankSidebar />);
    await expandProvider(/^Claude/);
    const row = metricRow('Weekly');

    fireEvent.pointerEnter(row, { pointerType: 'touch' });
    fireEvent.click(row);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Last 14 days');
    await waitFor(() => expect(mockHistory).toHaveBeenCalled());
    const query = mockHistory.mock.calls[0][0];
    expect(query.metric).toBe('weeklyAll');
    expect((query.until ?? 0) - query.since).toBe(14 * 24 * HOUR);

    fireEvent.click(row);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape and with the close button', async () => {
    render(<AgentTankSidebar />);
    await expandProvider(/^Claude/);

    fireEvent.click(metricRow('Session'));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.keyDown(metricRow('Session'), { key: 'Enter' });
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Close usage history' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('groups Gemini 4 Argon under its own pool and charts its weekly quota', async () => {
    render(<AgentTankSidebar />);
    await expandProvider(/^Antigravity/);

    expect(screen.getByText('Gemini 4 Argon')).toBeInTheDocument();
    fireEvent.click(metricRow('Weekly'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Antigravity · Gemini 4 Argon Weekly Limit usage history');
    await waitFor(() => expect(mockHistory).toHaveBeenCalled());
    const query = mockHistory.mock.calls[0][0];
    expect(query).toMatchObject({ agents: ['antigravity'], metric: 'model:Gemini 4 Argon Weekly Limit' });
    expect((query.until ?? 0) - query.since).toBe(14 * 24 * HOUR);
  });

  it('says so when there is not enough history yet', async () => {
    mockHistory.mockResolvedValue(history('claude', 'session', [17]));
    render(<AgentTankSidebar />);
    await expandProvider(/^Claude/);

    fireEvent.click(metricRow('Session'));

    expect(await screen.findByText(/Not enough history yet/)).toBeInTheDocument();
  });

  it('reads again when new usage is recorded while the overlay stays open', async () => {
    mockHistory.mockResolvedValueOnce(history('claude', 'session', [17]));
    render(<AgentTankSidebar />);
    await expandProvider(/^Claude/);

    fireEvent.click(metricRow('Session'));
    expect(await screen.findByText(/Not enough history yet/)).toBeInTheDocument();
    const before = mockHistory.mock.calls[0][0].until ?? 0;

    // The pinned overlay fills in from the new samples, past the re-hover cache.
    act(() => { usageListeners.forEach(listener => listener()); });
    expect(await screen.findByTestId('usage-metric-history-chart')).toBeInTheDocument();
    expect(screen.queryByText(/Not enough history yet/)).not.toBeInTheDocument();
    const calls = mockHistory.mock.calls.filter(([query]) => query.metric === 'session');
    expect(calls).toHaveLength(2);
    expect(calls[1][0].until ?? 0).toBeGreaterThanOrEqual(before);

    // Closed, it stops listening.
    fireEvent.click(screen.getByRole('button', { name: 'Close usage history' }));
    act(() => { usageListeners.forEach(listener => listener()); });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(mockHistory.mock.calls.filter(([query]) => query.metric === 'session')).toHaveLength(2);
  });

  it('stops offering history while the backend reports it disabled', async () => {
    mockHistory.mockResolvedValue({ enabled: false, agents: [] });
    render(<AgentTankSidebar />);
    await expandProvider(/^Claude/);
    fireEvent.click(metricRow('Session'));
    expect(await screen.findByText(/not available/)).toBeInTheDocument();

    // The other, closed rows go inert at once rather than on their next render.
    expect(screen.getByText('Weekly').closest('[aria-haspopup="dialog"]')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[aria-haspopup="dialog"]')).toBeNull();
  });

  it('offers history again once Agent Tank is re-enabled', async () => {
    mockHistory.mockResolvedValue({ enabled: false, agents: [] });
    const { unmount } = render(<AgentTankSidebar />);
    await expandProvider(/^Claude/);
    fireEvent.click(metricRow('Session'));
    expect(await screen.findByText(/not available/)).toBeInTheDocument();
    await act(async () => { unmount(); });

    // Re-enabled: the sidebar reads enabled usage again, and history is back.
    mockHistory.mockImplementation(async query => history(query.agents?.[0] ?? '', query.metric ?? '', [5, 12, 17]));
    render(<AgentTankSidebar />);
    await screen.findByText('Usage');
    await waitFor(() => expect(metricRow('Session')).not.toBeNull());
    fireEvent.click(metricRow('Session'));

    // The remembered "off" answer is not replayed: the row asks again.
    expect(await screen.findByTestId('usage-metric-history-chart')).toBeInTheDocument();
    expect(mockHistory).toHaveBeenCalledTimes(2);
  });

  it('lets a disabled answer lapse, so rows outside the sidebar can retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      mockHistory.mockResolvedValue({ enabled: false, agents: [] });
      const metric = { label: 'Session', percent: 17, historyKey: 'session', cycle: 'session' };
      render(
        <>
          <UsageMetricHistoryTrigger agent="claude" metric={metric}><span>Claude session</span></UsageMetricHistoryTrigger>
          <UsageMetricHistoryTrigger agent="codex" metric={{ ...metric, historyKey: 'fiveHour' }}><span>Codex session</span></UsageMetricHistoryTrigger>
        </>,
      );
      fireEvent.click(metricRow('Claude session'));
      expect(await screen.findByText(/not available/)).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(document.querySelector('[aria-haspopup="dialog"]')).toBeNull();

      mockHistory.mockImplementation(async query => history(query.agents?.[0] ?? '', query.metric ?? '', [5, 12, 17]));
      await act(async () => { vi.advanceTimersByTime(60_000); });

      expect(document.querySelectorAll('[aria-haspopup="dialog"]')).toHaveLength(2);
      fireEvent.click(metricRow('Claude session'));
      expect(await screen.findByTestId('usage-metric-history-chart')).toBeInTheDocument();
      expect(mockHistory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not offer real history to demo viewers', async () => {
    render(
      <DemoModeContext.Provider value={{ isDemoMode: true, isLoading: false }}>
        <AgentTankSidebar />
      </DemoModeContext.Provider>,
    );
    await expandProvider(/^Claude/);

    expect(screen.getByText('Session')).toBeInTheDocument();
    expect(document.querySelector('[aria-haspopup="dialog"]')).toBeNull();
    fireEvent.click(screen.getByText('Session'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockHistory).not.toHaveBeenCalled();
  });
});

describe('usage history model', () => {
  it('reads Agent Tank countdowns', () => {
    expect(parseResetCountdown('2h 14m')).toBe(2 * 3600 + 14 * 60);
    expect(parseResetCountdown('3d 4h')).toBe(3 * 86400 + 4 * 3600);
    expect(parseResetCountdown('136h 1m')).toBe(136 * 3600 + 60);
    expect(parseResetCountdown('soon')).toBeNull();
  });

  it('starts the current period one period before the next reset', () => {
    const until = 100 * HOUR;
    expect(currentPeriodStart({ until, periodMs: 5 * HOUR }, '2h')).toBe(until + 2 * HOUR - 5 * HOUR);
    // No countdown, or one longer than a period, falls back to one period ago.
    expect(currentPeriodStart({ until, periodMs: 5 * HOUR })).toBe(until - 5 * HOUR);
    expect(currentPeriodStart({ until, periodMs: 5 * HOUR }, '9h')).toBe(until - 5 * HOUR);
  });
});

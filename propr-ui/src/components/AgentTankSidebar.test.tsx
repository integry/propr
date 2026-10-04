import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageUpdatePayload } from '@propr/shared';
import { getAgentTankUsage, refreshAgentTank } from '../api/revertApi';
import type { AgentTankUsageResponse } from '../api/revertApi';
import AgentTankSidebar, { EXPANDED_AGENTS_STORAGE_KEY } from './AgentTankSidebar';

vi.mock('../api/revertApi', () => ({
  getAgentTankUsage: vi.fn(),
  refreshAgentTank: vi.fn(),
}));

const socketState = vi.hoisted(() => ({
  isConnected: true,
  usageCallbacks: new Set<(payload: UsageUpdatePayload) => void>(),
}));
vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: socketState.isConnected,
    onActivityUpdate: () => () => undefined,
    onNotificationUpdate: () => () => undefined,
    onUsageUpdate: (callback: (payload: UsageUpdatePayload) => void) => {
      socketState.usageCallbacks.add(callback);
      return () => socketState.usageCallbacks.delete(callback);
    },
  }),
}));

/** Delivers `usage:update` the way the server publishes it when a quota moves. */
async function pushUsageUpdate(): Promise<void> {
  await act(async () => {
    socketState.usageCallbacks.forEach(callback => callback({
      eventType: 'usage:update',
      provider: 'claude',
      occurredAt: '2026-09-26T12:00:00.000Z',
    }));
  });
}

const mockGetAgentTankUsage = vi.mocked(getAgentTankUsage);
const mockRefreshAgentTank = vi.mocked(refreshAgentTank);

const usageResponse = (): AgentTankUsageResponse => ({
  enabled: true,
  agents: {
    claude: {
      name: 'claude',
      usage: {
        session: { percent: 17, resetsIn: '2h 14m' },
        weeklyAll: { percent: 58, resetsIn: '3d 4h' },
        weeklySonnet: { percent: 82, resetsIn: '3d 4h' },
        weeklyFable: { percent: 41, resetsIn: '3d 4h', resetsInSeconds: 273600, pace: 0.8, paceEval: 'on_track' },
      },
    },
    codex: {
      name: 'codex',
      usage: {
        fiveHour: { percentUsed: 12, resetsIn: '3h 41m' },
        weekly: { percent: 64, resetsIn: '5d 2h' },
      },
    },
  },
});

// The widget renders nothing until the first fetch resolves.
async function renderSidebar(): Promise<HTMLElement> {
  render(<AgentTankSidebar />);
  return (await screen.findByText('Usage')).closest('div')!.parentElement!;
}

function providerRow(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(name) });
}

function storedExpansion(): unknown {
  const raw = window.localStorage.getItem(EXPANDED_AGENTS_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

beforeEach(() => {
  window.localStorage.clear();
  socketState.isConnected = true;
  socketState.usageCallbacks.clear();
  mockGetAgentTankUsage.mockResolvedValue(usageResponse());
  mockRefreshAgentTank.mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('AgentTankSidebar Claude metrics', () => {
  it('renders the Fable weekly quota alongside Session, Weekly and Sonnet', async () => {
    await renderSidebar();

    fireEvent.click(providerRow('Claude'));

    const fable = screen.getByText('Fable');
    expect(fable).toBeInTheDocument();
    expect(fable).toHaveAttribute('title', 'Resets in 3d 4h');
    // Fable follows Sonnet, directly after Claude's other weekly model quotas.
    const claudeMetrics = screen.getAllByText(/^(Session|Weekly|Sonnet|Fable)$/).map(node => node.textContent);
    expect(claudeMetrics.slice(0, 4)).toEqual(['Session', 'Weekly', 'Sonnet', 'Fable']);
    expect(fable.parentElement).toHaveTextContent('41%');
  });

  it('omits the Fable row when Agent Tank reports no Fable quota', async () => {
    const withoutFable = usageResponse();
    delete withoutFable.agents!.claude.usage!.weeklyFable;
    mockGetAgentTankUsage.mockResolvedValue(withoutFable);

    await renderSidebar();
    fireEvent.click(providerRow('Claude'));

    expect(screen.getByText('Sonnet')).toBeInTheDocument();
    expect(screen.queryByText('Fable')).not.toBeInTheDocument();
  });
});

// Agent Tank names Antigravity quotas after the window they cover, e.g.
// "Gemini · Weekly Limit Remaining", and reports a countdown for the windows it
// has started tracking (null for the rest).
const antigravityResponse = (): AgentTankUsageResponse => ({
  enabled: true,
  agents: {
    antigravity: {
      name: 'antigravity',
      usage: {
        models: [
          { model: 'Gemini · Weekly Limit Remaining', percentUsed: 12.2, resetsIn: '136h 1m' },
          { model: 'Gemini · Five Hour Limit Remaining', percentUsed: 0.3, resetsIn: '4h 37m' },
          { model: 'Claude and GPT · Weekly Limit Remaining', percentUsed: 0 },
        ],
      },
    },
  },
});

describe('AgentTankSidebar Antigravity rows', () => {
  beforeEach(() => {
    mockGetAgentTankUsage.mockResolvedValue(antigravityResponse());
  });

  it('drops the trailing "Remaining" from the model labels', async () => {
    await renderSidebar();

    fireEvent.click(providerRow('Antigravity'));

    expect(screen.getByText('Gemini · Weekly Limit')).toBeInTheDocument();
    expect(screen.getByText('Gemini · Five Hour Limit')).toBeInTheDocument();
    expect(screen.getByText('Claude and GPT · Weekly Limit')).toBeInTheDocument();
    expect(screen.queryByText(/Remaining/)).not.toBeInTheDocument();
  });

  it('reports when each quota resets, the way the other providers do', async () => {
    await renderSidebar();

    fireEvent.click(providerRow('Antigravity'));

    expect(screen.getByText('Gemini · Weekly Limit'))
      .toHaveAttribute('title', 'Gemini · Weekly Limit · Resets in 136h 1m');
    expect(screen.getByText('Gemini · Five Hour Limit'))
      .toHaveAttribute('title', 'Gemini · Five Hour Limit · Resets in 4h 37m');
  });

  it('keeps the model name alone when Agent Tank reports no reset window', async () => {
    await renderSidebar();

    fireEvent.click(providerRow('Antigravity'));

    expect(screen.getByText('Claude and GPT · Weekly Limit'))
      .toHaveAttribute('title', 'Claude and GPT · Weekly Limit');
  });
});

describe('AgentTankSidebar expansion persistence', () => {
  it('saves an expanded provider to localStorage', async () => {
    await renderSidebar();

    const claude = providerRow('Claude');
    expect(claude).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(claude);

    expect(providerRow('Claude')).toHaveAttribute('aria-expanded', 'true');
    expect(storedExpansion()).toEqual(['claude']);
  });

  it('removes a collapsed provider from localStorage', async () => {
    window.localStorage.setItem(EXPANDED_AGENTS_STORAGE_KEY, JSON.stringify(['claude', 'codex']));
    await renderSidebar();

    fireEvent.click(providerRow('Claude'));

    expect(providerRow('Claude')).toHaveAttribute('aria-expanded', 'false');
    expect(storedExpansion()).toEqual(['codex']);
  });

  it('restores expanded providers from localStorage on mount', async () => {
    window.localStorage.setItem(EXPANDED_AGENTS_STORAGE_KEY, JSON.stringify(['claude']));

    await renderSidebar();

    expect(providerRow('Claude')).toHaveAttribute('aria-expanded', 'true');
    expect(providerRow('Codex')).toHaveAttribute('aria-expanded', 'false');
    // Restored rows show their metric children without any user interaction.
    const claudeMetrics = within(providerRow('Claude').parentElement!);
    expect(claudeMetrics.getByText('Sonnet')).toBeInTheDocument();
    expect(claudeMetrics.getByText('Fable')).toBeInTheDocument();
  });

  it('keeps state across a remount, the way a page reload does', async () => {
    const first = render(<AgentTankSidebar />);
    await screen.findByText('Usage');
    fireEvent.click(providerRow('Codex'));
    first.unmount();

    render(<AgentTankSidebar />);
    await screen.findByText('Usage');

    expect(providerRow('Codex')).toHaveAttribute('aria-expanded', 'true');
    expect(providerRow('Claude')).toHaveAttribute('aria-expanded', 'false');
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['a non-array value', '{"claude":true}'],
  ])('falls back to collapsed rows when localStorage holds %s', async (_label, stored) => {
    window.localStorage.setItem(EXPANDED_AGENTS_STORAGE_KEY, stored);

    await renderSidebar();

    expect(providerRow('Claude')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Fable')).not.toBeInTheDocument();
    // The corrupt value is replaced, not rethrown, on the next toggle.
    fireEvent.click(providerRow('Claude'));
    expect(storedExpansion()).toEqual(['claude']);
  });

  it('keeps toggling when localStorage is unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    try {
      await renderSidebar();

      expect(providerRow('Claude')).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(providerRow('Claude'));

      expect(providerRow('Claude')).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('Fable')).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe('AgentTankSidebar usage refresh', () => {
  it('re-reads once when the server says capacity changed, and never on a timer', async () => {
    vi.useFakeTimers();
    try {
      render(<AgentTankSidebar />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(mockGetAgentTankUsage).toHaveBeenCalledTimes(1);

      // Five idle minutes: the widget used to poll three times over this span.
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
      expect(mockGetAgentTankUsage).toHaveBeenCalledTimes(1);

      await pushUsageUpdate();
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });

      expect(mockGetAgentTankUsage).toHaveBeenCalledTimes(2);
      expect(mockRefreshAgentTank).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still re-probes the providers from the manual refresh button', async () => {
    await renderSidebar();
    expect(mockGetAgentTankUsage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));

    await waitFor(() => expect(mockRefreshAgentTank).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockGetAgentTankUsage).toHaveBeenCalledTimes(2));
  });

  it('polls while the socket is unavailable so a client without one still updates', async () => {
    socketState.isConnected = false;
    vi.useFakeTimers();
    try {
      render(<AgentTankSidebar />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(mockGetAgentTankUsage).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(30_100); });

      expect(mockGetAgentTankUsage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

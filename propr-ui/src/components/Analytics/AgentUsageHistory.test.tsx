import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentTankHistory, type AgentTankHistoryResponse } from '../../api/revertApi';
import AgentUsageHistory from './AgentUsageHistory';
import { USAGE_SERIES_COLORS, usageSeriesStyle } from '../usageHistory/usageHistoryModel';
import {
  buildChartRows,
  parseUsageHistoryView,
  toPlottedSeries,
  writeUsageHistoryView,
} from './usageHistoryView';

vi.mock('../../api/revertApi', () => ({ getAgentTankHistory: vi.fn() }));
const usageListeners = vi.hoisted(() => new Set<() => void>());
vi.mock('../../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: true,
    onActivityUpdate: () => () => undefined,
    onUsageUpdate: (listener: () => void) => {
      usageListeners.add(listener);
      return () => { usageListeners.delete(listener); };
    },
  }),
}));
const publishUsage = () => act(() => { usageListeners.forEach(listener => listener()); });
// jsdom has no layout, so give the chart a fixed size and it draws its lines.
vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<typeof import('recharts')>();
  const { cloneElement } = await import('react');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 800, height: 280 }),
  };
});

const mockHistory = vi.mocked(getAgentTankHistory);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function series(key: string, label: string, percents: number[]) {
  const now = Date.now();
  return {
    key, label, model: null, cycle: 'session',
    points: percents.map((percent, index) => ({ t: new Date(now - (percents.length - index) * HOUR).toISOString(), percent })),
  };
}

const response = (): AgentTankHistoryResponse => ({
  enabled: true,
  source: 'propr',
  agents: [
    { agent: 'codex', series: [series('fiveHour', '5h limit', [3, 9, 12]), series('weekly', 'Weekly limit', [40, 41, 42])] },
    { agent: 'claude', series: [series('session', 'Current session', [10, 30, 17]), series('weeklyAll', 'Current week (all models)', [50, 55, 58])] },
    { agent: 'antigravity', series: [series('model:Gemini 4 Argon Weekly Limit', 'Gemini 4 Argon Weekly Limit', [20, 25, 30])] },
  ],
});

let location = '';
const LocationProbe = () => {
  location = useLocation().search;
  return null;
};

function renderPane(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/analytics${search}`]}>
      <AgentUsageHistory />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  mockHistory.mockReset();
  mockHistory.mockResolvedValue(response());
});

describe('AgentUsageHistory', () => {
  it('plots every agent and metric by default, over the last 7 days', async () => {
    renderPane();

    expect(await screen.findByTestId('agent-usage-history-chart')).toBeInTheDocument();
    const query = mockHistory.mock.calls[0][0];
    expect((query.until ?? 0) - query.since).toBe(7 * DAY);
    expect(query.agents).toBeUndefined();

    const filters = screen.getByRole('group', { name: 'Filter usage history' });
    // Providers in sidebar order, then one chip per series with its latest value.
    for (const name of ['Claude', 'Codex', 'Antigravity']) {
      expect(within(filters).getByRole('button', { name, pressed: true })).toBeInTheDocument();
    }
    expect(within(filters).getByRole('button', { name: /Claude · Session 17%/, pressed: true })).toBeInTheDocument();
    expect(within(filters).getByRole('button', { name: /Antigravity · Gemini 4 Argon Weekly 30%/ })).toBeInTheDocument();
  });

  it('hides an agent and a metric, and keeps the choice in the URL', async () => {
    renderPane();
    const filters = await screen.findByRole('group', { name: 'Filter usage history' });

    fireEvent.click(within(filters).getByRole('button', { name: 'Codex' }));
    expect(within(filters).queryByRole('button', { name: /Codex · Session/ })).not.toBeInTheDocument();
    fireEvent.click(within(filters).getByRole('button', { name: /Claude · Weekly/ }));
    expect(within(filters).getByRole('button', { name: /Claude · Weekly/, pressed: false })).toBeInTheDocument();

    expect(new URLSearchParams(location).get('usageHideAgents')).toBe('codex');
    expect(new URLSearchParams(location).get('usageHide')).toBe('claude:weeklyAll');

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(location).toBe('');
  });

  it('reads a new range and restores filters from the URL', async () => {
    renderPane('?usageRange=24h&usageHide=claude:session');
    await screen.findByTestId('agent-usage-history-chart');
    expect((mockHistory.mock.calls[0][0].until ?? 0) - mockHistory.mock.calls[0][0].since).toBe(DAY);
    expect(screen.getByRole('button', { name: /Claude · Session/, pressed: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Quota usage, last 14 days' }));
    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2));
    expect((mockHistory.mock.calls[1][0].until ?? 0) - mockHistory.mock.calls[1][0].since).toBe(14 * DAY);
  });

  it('offers the numbers as a table', async () => {
    renderPane();
    fireEvent.click(await screen.findByRole('button', { name: 'Table' }));

    const table = screen.getByTestId('agent-usage-history-table');
    const row = within(table).getByRole('row', { name: /Claude · Session/ });
    expect(row).toHaveTextContent('17%');
    expect(row).toHaveTextContent('10%');
    expect(row).toHaveTextContent('30%');
  });

  it('names model-derived series by display name, keeping quota pool wording', async () => {
    mockHistory.mockResolvedValue({
      enabled: true,
      source: 'propr',
      agents: [
        {
          agent: 'antigravity',
          series: [
            series('model:gemini-2.5-pro', 'gemini-2.5-pro', [10, 20]),
            series('model:Claude and GPT · Weekly Limit Remaining', 'Claude and GPT · Weekly Limit Remaining', [5, 6]),
            series('model:Gemini 4 Argon Weekly Limit', 'Gemini 4 Argon Weekly Limit', [20, 30]),
          ],
        },
        { agent: 'codex', series: [{ ...series('gpt-5.3-codex:weekly', 'gpt-5.3-codex Weekly limit', [7, 8]), model: 'gpt-5.3-codex' }] },
      ],
    });
    renderPane();
    const filters = await screen.findByRole('group', { name: 'Filter usage history' });

    const gemini = within(filters).getByRole('button', { name: /^Antigravity · Gemini 2\.5 Pro 20%/ });
    expect(gemini).toHaveTextContent('Gemini 2.5 Pro');
    expect(gemini).toHaveAttribute('title', 'Gemini 2.5 Pro');
    const codex = within(filters).getByRole('button', { name: /^Codex · GPT-5\.3 Codex Weekly 8%/ });
    expect(codex).toHaveAttribute('title', 'GPT-5.3 Codex Weekly limit');
    expect(within(filters).getByRole('button', { name: /^Antigravity · Claude and GPT · Weekly 6%/ }))
      .toHaveAttribute('title', 'Claude and GPT · Weekly Limit');
    expect(within(filters).getByRole('button', { name: /^Antigravity · Gemini 4 Argon Weekly 30%/ })).toBeInTheDocument();
    expect(filters.innerHTML).not.toMatch(/gemini-2\.5-pro|gpt-5\.3-codex/);

    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    const table = screen.getByTestId('agent-usage-history-table');
    expect(within(table).getByRole('row', { name: /Antigravity · Gemini 2\.5 Pro/ })).toBeInTheDocument();
    expect(table.innerHTML).not.toMatch(/gemini-2\.5-pro|gpt-5\.3-codex/);
  });

  it('renders nothing when Agent Tank is off or usage is not readable', async () => {
    mockHistory.mockResolvedValueOnce({ enabled: false, agents: [] });
    const { container, unmount } = renderPane();
    await waitFor(() => expect(container.querySelector('[data-testid="analytics-usage-history"]')).toBeNull());
    unmount();

    mockHistory.mockRejectedValueOnce(new Error('This action requires the instance.manage_agents permission'));
    const second = renderPane();
    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(second.container.querySelector('[data-testid="analytics-usage-history"]')).toBeNull());
  });

  it('plots every selected metric past the eight-hue palette, telling repeated hues apart by dash', async () => {
    const many = Array.from({ length: 10 }, (_, index) => series(`model:Pool ${index + 1}`, `Pool ${index + 1}`, [index, index + 1]));
    mockHistory.mockResolvedValue({ enabled: true, source: 'propr', agents: [{ agent: 'antigravity', series: many }] });
    const { container } = renderPane();
    const filters = await screen.findByRole('group', { name: 'Filter usage history' });

    // All ten metrics are drawn; nothing is left "not plotted".
    const strokes = () => [...container.querySelectorAll('.recharts-line-curve')]
      .map(path => [path.getAttribute('stroke'), path.getAttribute('stroke-dasharray')]);
    await waitFor(() => expect(strokes()).toHaveLength(10));
    expect(new Set(strokes().map(stroke => stroke.join('|'))).size).toBe(10);
    expect(strokes()[0]).toEqual([USAGE_SERIES_COLORS[0], null]);
    expect(strokes()[8]).toEqual([USAGE_SERIES_COLORS[0], usageSeriesStyle(8).dash]);
    expect(screen.queryByText(/not plotted/)).not.toBeInTheDocument();
    expect(within(filters).getAllByRole('button', { name: /Antigravity · Pool/, pressed: true })).toHaveLength(10);
    // A chip's swatch shows the line's dash, so the legend matches the chart.
    expect(within(filters).getByRole('button', { name: /Pool 9 9%/ }).querySelector('line'))
      .toHaveAttribute('stroke-dasharray', usageSeriesStyle(8).dash);

    // Hiding one metric removes only its line; the others keep their style.
    fireEvent.click(within(filters).getByRole('button', { name: /Pool 1 1%/ }));
    await waitFor(() => expect(strokes()).toHaveLength(9));
    expect(strokes()[7]).toEqual([USAGE_SERIES_COLORS[0], usageSeriesStyle(8).dash]);

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(strokes()).toHaveLength(10));

    // The table lists every selected metric too.
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    const table = screen.getByTestId('agent-usage-history-table');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 10);
    expect(within(table).getByRole('row', { name: /Pool 10/ })).toHaveTextContent('10%');
  });

  it('explains an empty history', async () => {
    mockHistory.mockResolvedValue({ enabled: true, agents: [] });
    renderPane();
    expect(await screen.findByText(/No usage history yet/)).toBeInTheDocument();
  });

  it('fills in an empty history once new usage is recorded, without leaving the page', async () => {
    mockHistory.mockResolvedValueOnce({ enabled: true, source: 'propr', agents: [] });
    renderPane();
    expect(await screen.findByText(/No usage history yet/)).toBeInTheDocument();
    const first = mockHistory.mock.calls[0][0];

    publishUsage();
    expect(await screen.findByTestId('agent-usage-history-chart')).toBeInTheDocument();
    expect(screen.queryByText(/No usage history yet/)).not.toBeInTheDocument();
    // The re-read covers the same range, ending now rather than at mount.
    const second = mockHistory.mock.calls[1][0];
    expect((second.until ?? 0) - second.since).toBe(7 * DAY);
    expect(second.until ?? 0).toBeGreaterThanOrEqual(first.until ?? 0);
  });

  it('moves the latest values forward and keeps the chart up while re-reading', async () => {
    renderPane();
    const filters = await screen.findByRole('group', { name: 'Filter usage history' });
    expect(within(filters).getByRole('button', { name: /Claude · Session 17%/ })).toBeInTheDocument();

    let answer: (value: AgentTankHistoryResponse) => void = () => undefined;
    mockHistory.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
    publishUsage();
    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('agent-usage-history-chart')).toBeInTheDocument();

    const next = response();
    next.agents[1].series[0] = series('session', 'Current session', [10, 30, 17, 44]);
    answer(next);
    expect(await within(filters).findByRole('button', { name: /Claude · Session 44%/ })).toBeInTheDocument();
  });

  it('keeps the last good history when a refresh fails', async () => {
    renderPane();
    await screen.findByTestId('agent-usage-history-chart');
    mockHistory.mockRejectedValueOnce(new Error('Agent Tank unreachable'));

    publishUsage();
    await waitFor(() => expect(mockHistory).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.getByTestId('agent-usage-history-chart')).toBeInTheDocument();
    expect(screen.queryByText('Agent Tank unreachable')).not.toBeInTheDocument();
  });

  it('shows a read failure with nothing to keep, and stops listening once unmounted', async () => {
    mockHistory.mockRejectedValueOnce(new Error('Agent Tank unreachable'));
    const { unmount } = renderPane();
    expect(await screen.findByText('Agent Tank unreachable')).toBeInTheDocument();

    unmount();
    expect(usageListeners.size).toBe(0);
  });
});

describe('usage history view', () => {
  it('round-trips the view through the URL, omitting defaults', () => {
    const view = parseUsageHistoryView(new URLSearchParams('usageRange=3d&usageHideAgents=codex'));
    expect(view.range).toBe('3d');
    expect([...view.hiddenAgents]).toEqual(['codex']);
    expect(parseUsageHistoryView(new URLSearchParams('usageRange=1y')).range).toBe('7d');
    expect(writeUsageHistoryView(new URLSearchParams('period=7d'), { ...view, range: '7d', hiddenAgents: new Set() }).toString())
      .toBe('period=7d');
  });

  it('gives every series up to 32 a distinct style, solid for the first eight', () => {
    const styles = Array.from({ length: 32 }, (_, index) => usageSeriesStyle(index));
    expect(styles.slice(0, 8)).toEqual(USAGE_SERIES_COLORS.map(color => ({ color })));
    expect(styles.slice(8).every(style => style.dash)).toBe(true);
    expect(new Set(styles.map(style => `${style.color}|${style.dash ?? ''}`)).size).toBe(32);
  });

  it('carries each series forward between its own readings and not past them', () => {
    const a = toPlottedSeries({ ...series('a', 'a', []), id: 'x:a', agent: 'x', displayLabel: 'a',
      points: [{ t: new Date(1000).toISOString(), percent: 10 }, { t: new Date(3000).toISOString(), percent: 30 }] }, { color: '#000' });
    const b = toPlottedSeries({ ...series('b', 'b', []), id: 'x:b', agent: 'x', displayLabel: 'b',
      points: [{ t: new Date(2000).toISOString(), percent: 50 }] }, { color: '#111' });
    expect(buildChartRows([a, b])).toEqual([
      { t: 1000, 'x:a': 10, 'x:b': null },
      { t: 2000, 'x:a': 10, 'x:b': 50 },
      { t: 3000, 'x:a': 30, 'x:b': null },
    ]);
  });
});

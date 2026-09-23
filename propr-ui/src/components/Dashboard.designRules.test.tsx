/**
 * The dashboard's studio design rules.
 *
 * These are assertions about rendered chrome rather than about data, and they
 * exist because every rule here has been regressed at least once: cards
 * returning to a tinted page, entity ids losing their type prefix, finished
 * work lit up in green. They are cheap to run and they fail loudly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Dashboard from './Dashboard';
import {
  getDashboardActive,
  getDashboardAttention,
  getDashboardOutcomes,
  getDashboardStats,
  getDashboardSummary,
} from '../api/dashboardApi';
import {
  CURRENT_DAY_FILL,
  PAST_DAY_FILL,
  dailyBarFill,
  utcToday,
} from './Dashboard/chartPalette';
import {
  activeItem,
  activeResponse,
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

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({ isConnected: true, onTaskUpdate: () => () => {} }),
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

// Recharts needs a measured container, which jsdom never provides. The colour
// rule is asserted directly against chartPalette, which is not stubbed.
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

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/']}>
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

describe('Dashboard studio design rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSummary.mockResolvedValue(summaryResponse());
    mockAttention.mockResolvedValue(attentionResponse());
    mockActive.mockResolvedValue(activeResponse([activeItem()]));
    mockOutcomes.mockResolvedValue(outcomesResponse([outcomeItem()]));
    mockStats.mockResolvedValue(statsResponse());
  });

  it('is one unbroken canvas rather than cards floating on a tinted page', async () => {
    const { container } = renderDashboard();
    await waitForSections();

    const canvas = container.querySelector('.min-h-full');
    expect(canvas).not.toBeNull();
    expect(canvas).toHaveClass('bg-white');
    expect(canvas?.className).not.toMatch(/bg-slate-50|bg-gray-50/);

    for (const testId of [
      'happening-now-section',
      'recent-outcomes-section',
      'historical-stats-section',
    ]) {
      const section = screen.getByTestId(testId);
      expect(section.className).not.toMatch(/rounded-(?:md|lg|xl|2xl|full)/);
      expect(section.className).not.toMatch(/shadow/);
    }
  });

  it('never renders a bare entity number, so an issue is never mistaken for a PR', async () => {
    mockActive.mockResolvedValue(activeResponse([
      activeItem({ id: 'issue-row', taskId: 'issue-row', issueNumber: 118, prNumber: null }),
    ]));
    mockOutcomes.mockResolvedValue(outcomesResponse([
      outcomeItem({ id: 'pr-row', issueNumber: null, prNumber: 2481 }),
    ]));

    renderDashboard();
    await waitForSections();

    expect(await screen.findByText('Issue #118')).toBeInTheDocument();
    expect(await screen.findByText('PR #2481')).toBeInTheDocument();
    // An unprefixed chip is the actual regression, so it is asserted absent.
    expect(screen.queryByText('#118')).toBeNull();
    expect(screen.queryByText('#2481')).toBeNull();
  });

  it('styles repository slugs and entity ids as monospace code chips', async () => {
    renderDashboard();
    await waitForSections();

    const repoChip = (await screen.findAllByTitle('acme/app'))[0];
    expect(repoChip.className).toMatch(/font-mono/);
    expect(repoChip.className).toMatch(/bg-slate-100/);
    expect(repoChip.className).toMatch(/border-slate-200/);

    const entityChip = (await screen.findAllByTitle('Issue #7'))[0];
    expect(entityChip.className).toMatch(/font-mono/);
    expect(entityChip.className).toMatch(/bg-slate-100/);
  });

  it('keeps every successful end state quiet and identical', async () => {
    mockOutcomes.mockResolvedValue(outcomesResponse([
      outcomeItem({ id: 'merged-row', kind: 'merged', title: 'Merged work' }),
      outcomeItem({ id: 'completed-row', taskId: 'done-2', kind: 'completed', title: 'Completed work' }),
    ]));

    renderDashboard();
    await waitForSections();

    // "Completed" also labels a historical metric, so scope to the feed.
    const feed = await screen.findByTestId('recent-outcomes-section');
    const merged = await within(feed).findByText('Merged');
    const completed = await within(feed).findByText('Completed');
    // Two successful end states must not be told apart by colour.
    expect(merged.className).toBe(completed.className);
    for (const label of [merged, completed]) {
      expect(label.className).not.toMatch(/text-(?:green|emerald|teal)-/);
    }
  });

  it('marks active work with motion, not with a green status light', async () => {
    renderDashboard();
    await waitForSections();

    const section = screen.getByTestId('happening-now-section');
    expect(section).toHaveTextContent('Implementing');
    expect(section.querySelector('.animate-spin')).not.toBeNull();
    expect(section.innerHTML).not.toMatch(/bg-(?:green|emerald)-/);
  });

  it('colours only the in-progress day of the historical chart', () => {
    const today = utcToday();
    expect(dailyBarFill(today, today)).toBe(CURRENT_DAY_FILL);
    expect(dailyBarFill('2026-09-17', today)).toBe(PAST_DAY_FILL);
    // A settled day stays neutral no matter how many completions it holds.
    expect(dailyBarFill('2020-01-01', today)).toBe(PAST_DAY_FILL);
  });

  it('spends one compact row on the four top-level counts', async () => {
    renderDashboard();
    await waitForSections();

    const strip = screen.getByTestId('summary-strip');
    for (const testId of ['summary-needs-attention', 'summary-running', 'summary-queued', 'summary-completed']) {
      const count = screen.getByTestId(testId);
      expect(strip).toContainElement(count);
      // A count is a label beside a number, not a card wrapping one.
      expect(count.className).toMatch(/items-baseline/);
      expect(count.className).not.toMatch(/rounded-(?:md|lg|xl)/);
      expect(count.className).not.toMatch(/flex-col/);
    }
  });
});

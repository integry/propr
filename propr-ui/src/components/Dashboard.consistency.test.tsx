/**
 * The dashboard's consistency rules.
 *
 * One vocabulary across the console: one row schema in every section, one
 * delimiter glyph in every string, one label short enough for the narrowest
 * column it ever sits in, and one behaviour per row. Each rule here was a
 * separate thing that read as "written by two different engineers" on the same
 * screen, which is exactly the kind of regression nothing else catches.
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
} from '../api/dashboardApi';
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

// Recharts needs a measured container, which jsdom never provides.
vi.mock('./Dashboard/DailyCompletionsChart', () => ({ DailyCompletionsChart: () => null }));

vi.mock('../utils/repoHelpers', () => ({
  fetchEnabledRepos: vi.fn(async () => [{ name: 'acme/app', enabled: true }]),
}));

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

describe('Dashboard consistency rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAttention.mockResolvedValue(attentionResponse([attentionItem()]));
    mockActive.mockResolvedValue(activeResponse([activeItem()]));
    mockOutcomes.mockResolvedValue(outcomesResponse([outcomeItem()]));
    mockStats.mockResolvedValue(statsResponse());
  });

  it('gives an attention row the same schema as a feed row, re-flowed for the rail', async () => {
    mockAttention.mockResolvedValue(attentionResponse([attentionItem()]));

    renderDashboard();
    await waitForSections();

    // Three sections stacked down a phone used to carry three different
    // hierarchies — chips on line one here, on line two there — so the reading
    // plane jumped at every heading. One placement grid holds both readings:
    // status opposite time, chips opposite the action, then the title.
    const panel = await screen.findByTestId('needs-attention-panel');
    const status = await within(panel).findByText('Run failed');
    const row = status.parentElement as HTMLElement;
    expect(row.className).toMatch(/grid/);
    expect([...row.children].indexOf(status)).toBe(0);

    // The chips stay together in one cell, so the entity never drops onto a
    // line of its own, and in the narrow rail that cell rides beside the
    // status rather than under it.
    const chips = within(panel).getByTitle('Issue #42').parentElement as HTMLElement;
    expect(chips).toContainElement(within(panel).getAllByTitle('acme/app')[0]);
    expect(status.className).toMatch(/lg:row-start-1/);
    expect(chips.className).toMatch(/lg:row-start-1/);

    // Waiting time and action close the row in the rail; on a phone they are
    // the right-hand ends of the first two lines.
    const waiting = within(panel).getByText(/^Waiting /);
    const action = within(panel).getByRole('link', { name: /^Open/ });
    expect(waiting.className).toMatch(/lg:row-start-3/);
    expect(action.className).toMatch(/lg:row-start-3/);
    expect(waiting.className).toMatch(/justify-self-end/);
    expect(action.className).toMatch(/justify-self-end/);
  });

  it('makes a running row one destination rather than hinting at an accordion', async () => {
    renderDashboard();
    await waitForSections();

    // A chevron on the edge of a feed row promises an inline accordion. This
    // row opens the task instead, so drawing one claimed a behaviour the row
    // does not have — and on a phone the arrow sat against the elapsed time it
    // was crowding.
    const list = await screen.findByTestId('happening-now-list');
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
    expect(list.querySelector('[aria-expanded]')).toBeNull();
    expect(list.querySelector('svg.lucide-chevron-down')).toBeNull();
    expect(within(list).getAllByRole('link')[0]).toHaveAttribute('href', '/tasks/run-1');
  });

  it('stops a phone\'s progress line at its first clause instead of mid-word', async () => {
    mockActive.mockResolvedValue(activeResponse([
      activeItem({
        progressLine: 'Editing propr-ui/src/components/Dashboard/HappeningNowSection.tsx and re-running the suite',
      }),
    ]));

    renderDashboard();
    await waitForSections();

    // Collapsing the path was not enough: the clamp still cut the tail at
    // `and re…`, which reads as an accidental string slice. The phone gets the
    // action and the file, and the wide viewport still gets the sentence.
    const section = screen.getByTestId('happening-now-section');
    const short = within(section).getByText('Editing …/HappeningNowSection.tsx');
    expect(short.className).toMatch(/sm:hidden/);
    const full = within(section).getByText(
      'Editing propr-ui/src/components/Dashboard/HappeningNowSection.tsx and re-running the suite',
    );
    expect(full.className).toMatch(/sm:inline/);
  });

  it('never truncates a label in the metric grid', async () => {
    renderDashboard();
    await waitForSections();

    // `RECORDED SP…` reads as a broken grid rather than as a heading, and a
    // three-column row 22rem wide has no space to give it. The copy is short
    // enough to fit instead of being cut to fit; the qualification it carried
    // is a tooltip on the label.
    const stats = screen.getByTestId('historical-stats-section');
    for (const label of ['Completed', 'Success', 'Spend']) {
      const node = within(stats).getByText(label);
      expect(node.className).not.toMatch(/truncate/);
    }
    expect(within(stats).getByText('Spend')).toHaveAttribute('title', expect.stringContaining('Recorded spend'));
  });

  it('keeps the scope bar to the filter alone, with no socket commentary', async () => {
    renderDashboard();
    await waitForSections();

    // `Dashboard ● Reconnecting · Last updated 2m` spent the top row on the
    // app's own plumbing — and spent two different glyphs saying it, a status
    // light doing duty as a bullet beside an interpunct. The only thing above
    // the console is what it is filtered to.
    const scopeBar = screen.getByTestId('dashboard-scope-bar');
    expect(scopeBar.textContent).toBe('All Repos');
    expect(screen.queryByText(/Reconnecting|Last updated/)).toBeNull();
    expect(screen.queryByTestId('live-status')).toBeNull();
  });

  it('drops the owner from every repository chip, in both columns', async () => {
    mockAttention.mockResolvedValue(attentionResponse([attentionItem()]));

    renderDashboard();
    await waitForSections();

    // One screen cannot spell the same repository two ways. The owner is the
    // constant the filter above the console already establishes, so it goes
    // everywhere rather than only where a chip would otherwise truncate — and
    // it stays in the tooltip.
    for (const testId of ['needs-attention-panel', 'happening-now-section', 'recent-outcomes-section']) {
      const chip = within(await screen.findByTestId(testId)).getAllByTitle('acme/app')[0];
      expect(chip).toHaveTextContent(/^app$/);
      expect(chip.textContent).not.toMatch(/acme/);
    }
  });

  it('reads a long elapsed time in hours instead of counting minutes up', async () => {
    mockActive.mockResolvedValue(activeResponse([
      activeItem({ createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString() }),
    ]));

    renderDashboard();
    await waitForSections();

    // `240m 00s` is a raw minute count printed rather than a duration read.
    const section = screen.getByTestId('happening-now-section');
    expect(within(section).getByText('4h 00m')).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/\d{3,}m/);
  });

  it('never fills an attention title with the chip already on the row', async () => {
    mockAttention.mockResolvedValue(attentionResponse([
      attentionItem({
        id: 'plan-issue:31',
        category: 'decision',
        kind: 'plan_review',
        taskId: null,
        prNumber: 2482,
        issueNumber: 2468,
        title: null,
        state: 'under_review',
        detail: 'Pull request is awaiting review',
      }),
    ]));

    renderDashboard();
    await waitForSections();

    // `Pull request #2482` under a `PR #2482` chip is the chip read twice: the
    // one line with room to say what the reviewer is being asked to look at
    // repeated the identifier beside it instead.
    const panel = await screen.findByTestId('needs-attention-panel');
    expect(within(panel).getByText('PR #2482')).toBeInTheDocument();
    expect(within(panel).queryByText('Pull request #2482')).toBeNull();
    expect(within(panel).getByText('Pull request is awaiting review')).toBeInTheDocument();
  });

  it('keeps the phone\'s last pane clear of the fixed bottom navigation', async () => {
    const { container } = renderDashboard();
    await waitForSections();

    // The shell pads the scrolling canvas by exactly the navigation's height,
    // which leaves the last metric row and the chart flush against its top
    // rule. The console ends with a gap under it, on the widths that have a
    // bar to clear.
    const canvas = container.querySelector('.min-h-full') as HTMLElement;
    expect(canvas.className).toMatch(/\bpb-6\b/);
    expect(canvas.className).toMatch(/md:pb-0/);
  });
});

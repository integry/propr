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
import { HeaderScopeSlotContext } from './headerScopeSlot';
import {
  getDashboardActive,
  getDashboardAttention,
  getDashboardOutcomes,
  getDashboardStats,
  getDashboardSummary,
} from '../api/dashboardApi';
import {
  CURRENT_DAY_FILL,
  dailyPointFill,
  utcToday,
} from './Dashboard/chartPalette';
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

/** `headerSlot` stands in for the global toolbar's scope slot, which the layout owns. */
function renderDashboard(headerSlot: HTMLElement | null = null) {
  return render(
    <HeaderScopeSlotContext.Provider value={headerSlot}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
        </Routes>
      </MemoryRouter>
    </HeaderScopeSlotContext.Provider>,
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
      'completed-section',
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

  it('draws the repository as a muted chip and the entity id as bare monospace text', async () => {
    renderDashboard();
    await waitForSections();

    const repoChip = (await screen.findAllByTitle('acme/app'))[0];
    expect(repoChip.className).toMatch(/font-mono/);
    expect(repoChip.className).toMatch(/bg-slate-100/);
    expect(repoChip.className).not.toMatch(/\bborder\b/);

    // Two identical boxes side by side read as one wall of gray bricks; the
    // identifier is text, not a second chip.
    const entity = (await screen.findAllByTitle('Issue #7'))[0];
    expect(entity.className).toMatch(/font-mono/);
    expect(entity.className).not.toMatch(/\bbg-/);
    expect(entity.className).not.toMatch(/\bborder\b/);
  });

  it('puts the task type in front of a title as a badge and drops the prefix, number and model', async () => {
    mockActive.mockResolvedValue(activeResponse([
      activeItem({ title: 'Followup: [870 by Claude Opus 4.6] Implement feature gating', taskType: 'pr-comment' }),
    ]));

    renderDashboard();
    await waitForSections();

    const section = screen.getByTestId('happening-now-section');
    const badge = await within(section).findByTestId('work-type-badge');
    expect(badge).toHaveTextContent('Follow-up');
    // A micro-label with a neutral glyph, not a third boxed chip.
    expect(badge.className).toMatch(/uppercase/);
    expect(badge.className).not.toMatch(/\bbg-|\bborder\b|font-mono/);
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(section).toHaveTextContent('Implement feature gating');
    expect(section).not.toHaveTextContent('Followup:');
    expect(section).not.toHaveTextContent('Claude Opus');
  });

  it('gives running work no status badge, since every row in the pane is running', async () => {
    renderDashboard();
    await waitForSections();

    const section = screen.getByTestId('happening-now-section');
    expect(await within(section).findByText('Add retry budget')).toBeInTheDocument();
    expect(section).not.toHaveTextContent('Implementing');
    expect(section.querySelector('.animate-spin')).toBeNull();
    expect(section.innerHTML).not.toMatch(/bg-(?:green|emerald)-/);
  });

  it('marks only the in-progress day of the historical chart', () => {
    const today = utcToday();
    expect(dailyPointFill(today, today)).toBe(CURRENT_DAY_FILL);
    expect(dailyPointFill('2026-09-17', today)).toBeNull();
    // A settled day carries no marker, however many completions it holds.
    expect(dailyPointFill('2020-01-01', today)).toBeNull();
  });

  it('spends no row on a page bar: the filter sits in the global toolbar and the console starts at the top', async () => {
    const headerSlot = document.createElement('div');
    document.body.appendChild(headerSlot);
    renderDashboard(headerSlot);
    await waitForSections();

    // The counts strip only repeated what the pane headings and the queue
    // footer already say, so it is gone — and so is its read.
    expect(screen.queryByTestId('summary-strip')).toBeNull();
    expect(screen.queryByLabelText('Work summary')).toBeNull();
    expect(mockSummary).not.toHaveBeenCalled();

    // No page bar and no visible title: the highlighted navigation already
    // says where you are. The heading stays for assistive technology only.
    expect(screen.queryByTestId('dashboard-toolbar')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Dashboard', level: 1 })).toHaveClass('sr-only');

    // From `lg` up the filter is mounted in the global toolbar, beside search,
    // as a 28px trigger that fits that bar.
    const headerFilter = within(headerSlot).getByRole('button', { name: /All Repos/ });
    expect(headerFilter.className).toMatch(/\bh-7\b/);
    expect(headerFilter).not.toHaveTextContent(/acme/);

    // Narrower than that the filter is the title bar: alone on its row,
    // centered, and gone once the global toolbar has room for it.
    const scopeBar = screen.getByTestId('dashboard-scope-bar');
    expect(scopeBar.className).toMatch(/(?:^|\s)lg:hidden(?:\s|$)/);
    expect(scopeBar.children).toHaveLength(1);
    expect(scopeBar.textContent).not.toMatch(/Dashboard/);
    expect(within(scopeBar).getByRole('button', { name: /All Repos/ })).toHaveClass('w-full', 'justify-center');

    // The split pane follows directly, with no margin above it.
    const panes = scopeBar.nextElementSibling as HTMLElement | null;
    expect(panes).toContainElement(screen.getByTestId('happening-now-section'));
    expect(panes?.className).not.toMatch(/(?:^|\s)(?:[a-z]+:)?(?:m[ty]?|pt|py)-/);
    headerSlot.remove();
  });

  it('fills the attention pane with its zero-state instead of stranding one line at the top', async () => {
    renderDashboard();
    await waitForSections();

    // The pane is as tall as the running feed beside it whatever its count, so
    // a single line pinned to its ceiling leaves a cavern of white that reads
    // as content that failed to load. The zero-state occupies the pane.
    const empty = screen.getByTestId('needs-attention-empty');
    expect(empty.className).toMatch(/h-full/);
    expect(empty.className).toMatch(/flex-1/);
    expect(empty.className).toMatch(/items-center/);
    expect(empty.className).toMatch(/justify-center/);
    // A glyph above the sentence, quiet enough not to read as a reward.
    expect(empty.querySelector('svg')).not.toBeNull();

    // The panel has to be a full-height column for the state to centre in it.
    const panel = screen.getByTestId('needs-attention-panel');
    expect(panel.className).toMatch(/h-full/);
    expect(panel.className).toMatch(/flex-col/);
  });

  it('never separates two facts in a row with a bullet that can wrap away from them', async () => {
    mockActive.mockResolvedValue(activeResponse([activeItem()], [activeItem({ id: 'task:q', taskId: 'q' })]));

    renderDashboard();
    await waitForSections();

    // An interpunct is an inline separator. When the line wrapped it went with
    // the fact after it and started the next line as an orphaned bullet, which
    // reads as an unparsed template string. Space and borders separate instead.
    for (const testId of ['happening-now-section', 'completed-section', 'needs-attention-panel']) {
      expect(screen.getByTestId(testId).textContent).not.toMatch(/•/);
    }
  });

  it('collapses a raw repository path in a progress line on a phone only', async () => {
    mockActive.mockResolvedValue(activeResponse([
      activeItem({ progressLine: 'Editing propr-ui/src/components/Dashboard/HappeningNowSection.tsx now' }),
    ]));

    renderDashboard();
    await waitForSections();

    // 110 characters of path wrapped to three lines of the densest text on the
    // screen. Someone triaging on a phone needs the file, not the route to it.
    const section = screen.getByTestId('happening-now-section');
    const short = within(section).getByText('Editing …/HappeningNowSection.tsx now');
    expect(short.className).toMatch(/sm:hidden/);
    const full = within(section).getByText('Editing propr-ui/src/components/Dashboard/HappeningNowSection.tsx now');
    expect(full.className).toMatch(/hidden/);
    expect(full.className).toMatch(/sm:inline/);
  });

  it('separates rows with space instead of drawing a rule under every one', async () => {
    mockActive.mockResolvedValue(activeResponse([
      activeItem({ id: 'active-1', taskId: 'active-1' }),
      activeItem({ id: 'active-2', taskId: 'active-2' }),
    ]));
    mockOutcomes.mockResolvedValue(outcomesResponse([
      outcomeItem({ id: 'out-1' }),
      outcomeItem({ id: 'out-2', taskId: 'done-2' }),
    ]));
    mockAttention.mockResolvedValue(attentionResponse([
      attentionItem(),
      attentionItem({ id: 'task_failed:t-9', taskId: 't-9' }),
    ]));

    renderDashboard();
    await waitForSections();

    // A hairline repeated once per row stops reading as structure and becomes
    // texture, which is what made the console look like ruled paper. Rules are
    // spent on pane edges and pane headers only.
    const lists = [
      await screen.findByTestId('happening-now-list'),
      await screen.findByTestId('completed-list'),
      screen.getByTestId('needs-attention-panel').querySelector('ul'),
    ];
    for (const list of lists) {
      const rows = [...(list?.children ?? [])] as HTMLElement[];
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) expect(row.className).not.toMatch(/border/);
    }

    // The same rule applies to the metric row: three numbers, no ruled cells.
    const stats = screen.getByTestId('historical-stats-section');
    expect(stats.querySelector('[class*="divide-x"]')).toBeNull();
  });

  it('divides the two panes with one continuous rule instead of boxing each quadrant', async () => {
    const { container } = renderDashboard();
    await waitForSections();

    const grid = container.querySelector('.grid.flex-1');
    expect(grid).not.toBeNull();
    // The last row absorbs the leftover height, which is what carries the
    // column rule to the bottom of the canvas rather than to the last row of
    // content.
    expect(grid?.className).toMatch(/lg:grid-rows-\[auto_minmax\(min-content,1fr\)\]/);

    // The divider hangs off the main column and nothing else draws one, so
    // there is exactly one vertical line between the panes.
    const cells = [...(grid?.children ?? [])] as HTMLElement[];
    const divided = cells.filter(cell => /lg:border-r/.test(cell.className));
    expect(divided.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.className).not.toMatch(/rounded/);
      expect(cell.className).not.toMatch(/shadow/);
      // A quadrant is bounded by shared rules, never by its own four sides.
      expect(cell.className).not.toMatch(/\bborder\b(?!-)/);
    }
  });

  it('lands both columns\' pane headers on the same horizon', async () => {
    mockAttention.mockResolvedValue(attentionResponse([attentionItem()]));

    renderDashboard();
    await waitForSections();

    // A section with a segmented control must not sit taller than one without,
    // or the rules under the two columns stop lining up.
    const headings = ['happening-now-heading', 'needs-attention-heading', 'completed-heading', 'historical-stats-heading']
      .map(id => document.getElementById(id)?.parentElement);
    expect(headings.filter(Boolean)).toHaveLength(4);
    for (const heading of headings) {
      expect(heading?.className).toMatch(/min-h-10/);
      expect(heading?.className).toMatch(/border-b/);
    }
  });

  it('draws a review score as the fixed-width quality pill, never as /10 prose', async () => {
    mockOutcomes.mockResolvedValue(outcomesResponse([
      outcomeItem({ id: 'nine', title: 'Review PR #100: Retry budget', score: 9 }),
      outcomeItem({ id: 'seven', taskId: 'done-2', title: 'Review PR #101: Queue', score: 7 }),
    ]));

    renderDashboard();
    await waitForSections();

    const scores = await screen.findAllByTestId('completed-score');
    expect(scores).toHaveLength(2);
    for (const score of scores) {
      // Variable-width prose beside a fixed badge is what made the rail move.
      expect(score.textContent).not.toMatch(/\/10/);
      const pill = score.querySelector('span[title^="Review Score"]');
      expect(pill?.className).toMatch(/w-12/);
      expect(pill?.textContent).toMatch(/^\[\d+\]$/);
    }
  });

  it('gives every attention action the same fixed-width verb', async () => {
    // Two different verbs in the same column is the case that used to ragged
    // the left edge, so both kinds are on screen for this assertion.
    mockAttention.mockResolvedValue(attentionResponse([
      attentionItem(),
      attentionItem({ id: 'plan-issue:5', kind: 'plan_review', category: 'decision', taskId: null, prNumber: 51, title: null }),
    ]));

    renderDashboard();
    await waitForSections();

    const panel = screen.getByTestId('needs-attention-panel');
    const actions = within(panel).getAllByRole('link', { name: /^(Open|Review)\b/ });
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.className).toMatch(/\bw-20\b/);
      expect(action.className).toMatch(/justify-center/);
      // The face of the button is one verb; the entity is announced, not drawn.
      expect(action.firstChild?.textContent).toMatch(/^(Open|Review)$/);
    }
  });

  it('closes a list with one footer bar instead of a floating expand link', async () => {
    mockActive.mockResolvedValue(activeResponse(
      Array.from({ length: 9 }, (_, index) => activeItem({ id: `active-${index}`, taskId: `t-${index}` })),
      [activeItem({ id: 'task:q', taskId: 'q', state: 'pending', phase: 'Waiting' })],
    ));

    renderDashboard();
    await waitForSections();

    // The queue summary and the expand control are the same bar: a centred
    // link hovering above a tinted strip reads as a stray link, not as the
    // end of the list.
    const footer = await screen.findByTestId('happening-now-footer');
    expect(footer.className).toMatch(/bg-slate-50/);
    expect(footer).toContainElement(screen.getByTestId('queue-summary'));
    expect(footer).toContainElement(screen.getByRole('button', { name: 'Show 4 more' }));
  });

  it('pins the queue footer to the floor of the running pane', async () => {
    mockActive.mockResolvedValue(activeResponse([activeItem()], [activeItem({ id: 'task:q', taskId: 'q' })]));
    mockAttention.mockResolvedValue(attentionResponse([
      attentionItem({ id: 'a-1', taskId: 'a-1' }),
      attentionItem({ id: 'a-2', taskId: 'a-2', issueNumber: 43 }),
      attentionItem({ id: 'a-3', taskId: 'a-3', issueNumber: 44 }),
    ]));

    renderDashboard();
    await waitForSections();

    // One running task beside three attention items left the queue bar
    // stranded at the top of a pane sized by the column next to it, with a
    // quarter-screen of white between it and the rule below. The pane is a
    // column with a floor: the list area takes the slack, the bar closes it.
    const section = screen.getByTestId('happening-now-section');
    expect(section.className).toMatch(/\bflex\b/);
    expect(section.className).toMatch(/flex-col/);
    expect(section.className).toMatch(/h-full/);

    const list = screen.getByTestId('happening-now-list');
    expect((list.parentElement as HTMLElement).className).toMatch(/flex-1/);

    const footer = screen.getByTestId('happening-now-footer');
    expect(footer.className).toMatch(/mt-auto/);
    expect(section.lastElementChild).toBe(footer);
  });

  it('draws a single overflow row rather than folding it behind a toggle', async () => {
    mockActive.mockResolvedValue(activeResponse(
      Array.from({ length: 6 }, (_, index) => activeItem({ id: `active-${index}`, taskId: `t-${index}` })),
    ));

    renderDashboard();
    await waitForSections();

    // "Show 1 more" spends a line of chrome and a click to reveal a line of
    // content, in a column that has the room for it.
    const list = await screen.findByTestId('happening-now-list');
    expect(list.children).toHaveLength(6);
    expect(screen.queryByRole('button', { name: /Show 1 more/ })).toBeNull();
  });
});

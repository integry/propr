/**
 * Dashboard responsive layout rules.
 *
 * Every assertion here is about geometry and DOM order rather than about data,
 * because these are the rules that regress silently: a row that overflows a
 * 320px viewport, a supporting panel that drifts into the main column, an
 * empty score column reserved on a phone, a title cut off mid-word.
 *
 * The suite runs against stubbed HTTP and a closed socket, so it needs no
 * backend, no Redis, no credentials and no network.
 */

import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const now = Date.parse('2026-09-23T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

/** Widths the dashboard has to survive: two phones, a small laptop, a desktop. */
const NARROW_WIDTHS = [320, 390] as const;
const WIDE_WIDTHS = [1024, 1440] as const;

/**
 * A title that needs two lines at 320px and a progress line that needs more
 * than one. Together they are the wrap rule: the title wraps rather than being
 * cut off, and the secondary line is the one that gives way.
 */
const LONG_TITLE = 'Keep the retry budget from leaking into post-processing';
const LONG_PROGRESS_LINE =
  'Editing propr-ui/src/components/Dashboard/HappeningNowSection.tsx and re-running the dashboard section suite';
/**
 * What a phone shows: the directories collapsed and the sentence stopped at
 * its first clause. Clamping the full line cut it at `and re…`, which reads as
 * a string sliced by accident rather than as a line shortened on purpose.
 */
const SHORT_PROGRESS_LINE = 'Editing …/HappeningNowSection.tsx';

const running = [
  { id: 'task:run-1', taskId: 'run-1', repository: 'example/workspace', issueNumber: 2480, prNumber: null, taskType: null, title: LONG_TITLE, state: 'claude_execution', phase: 'Implementing', progressLine: LONG_PROGRESS_LINE, activity: 'Editing HappeningNowSection.tsx', step: { current: 2, total: 6 }, lastActivityAt: minutesAgo(18), createdAt: minutesAgo(26), updatedAt: minutesAgo(1) },
  { id: 'task:run-2', taskId: 'run-2', repository: 'example/design-system', issueNumber: 118, prNumber: 119, taskType: 'pr-comment', title: 'Fix PR #119: Align the score badge with the completed feed', state: 'post_processing', phase: 'Finishing up', progressLine: 'Pushing branch', createdAt: minutesAgo(9), updatedAt: minutesAgo(2) },
];

const attention = [
  { id: 'plan-issue:31', category: 'decision', kind: 'plan_review', taskId: null, repository: 'example/docs', issueNumber: 58, prNumber: 59, taskType: null, title: null, state: 'under_review', detail: 'Pull request is awaiting review', since: minutesAgo(20) },
  { id: 'task:blocked-1', category: 'blocked', kind: 'task_failed', taskId: 'blocked-1', repository: 'example/workspace', issueNumber: 2470, prNumber: null, taskType: 'issue', title: 'Retry budget never applies to post-processing', state: 'failed', detail: 'Lint failed', since: minutesAgo(190) },
];

/** The first completion is a scored review; the second deliberately carries no score. */
const outcomes = [
  { id: 'task:done-1:completed', taskId: 'done-1', repository: 'example/workspace', issueNumber: 2466, prNumber: 2467, taskType: 'pr-comment', title: 'Review PR #2467: Show corrective operator messages in the goal timeline', detail: '1 issue found: Missing timeline test', score: 9, occurredAt: minutesAgo(46) },
  { id: 'task:done-2:completed', taskId: 'done-2', repository: 'example/design-system', issueNumber: 115, prNumber: null, taskType: 'issue', title: 'Tighten the reference chip contrast', detail: null, score: null, occurredAt: minutesAgo(88) },
];

const SCORED_OUTCOMES = outcomes.filter(outcome => outcome.score !== null).length;

/**
 * A plain member on purpose: the admin-only banners (onboarding, missing
 * default model, Agent Tank detection) would otherwise push the dashboard down
 * the page and change the DOM order the layout tests read.
 */
const user = {
  id: 'responsive-user',
  login: 'operator',
  username: 'operator',
  displayName: 'Dana Okonkwo',
  email: null,
  avatarUrl: null,
  role: 'member',
  permissions: [],
  authorizationSource: 'local',
};

const dashboardResponses = (attentionItems: typeof attention): Record<string, unknown> => ({
  '/api/dashboard/summary': {
    repository: 'all',
    needsAttention: attentionItems.length,
    running: running.length,
    queued: 1,
    completedRecently: 2,
    recentWindowHours: 24,
  },
  '/api/dashboard/attention': {
    repository: 'all',
    items: attentionItems,
    counts: {
      blocked: attentionItems.filter(item => item.category === 'blocked').length,
      decisions: attentionItems.filter(item => item.category === 'decision').length,
      total: attentionItems.length,
    },
  },
  '/api/dashboard/active': {
    repository: 'all',
    running,
    queued: [],
    queue: { queuedCount: 1, reason: 'All agents are busy' },
    counts: { running: running.length, queued: 1 },
  },
  '/api/dashboard/outcomes': { repository: 'all', limit: 50, items: outcomes },
  '/api/stats/dashboard': {
    period: '7d',
    repository: 'all',
    completed: 34,
    successRate: 87.5,
    recordedSpend: 12.42,
    dailyCompleted: [
      { date: '2026-09-17', count: 4 }, { date: '2026-09-18', count: 7 }, { date: '2026-09-19', count: 3 },
      { date: '2026-09-20', count: 6 }, { date: '2026-09-21', count: 2 }, { date: '2026-09-22', count: 8 },
      { date: '2026-09-23', count: 4 },
    ],
    previous: { completed: 29, successRate: 81.2, recordedSpend: 9.8 },
  },
});

async function fixture(page: Page, attentionItems: typeof attention = attention): Promise<void> {
  await page.clock.install({ time: now });
  // No live socket: the layout rules are about rendered geometry, not updates.
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      '/api/auth/user': user,
      '/api/config/agent-tank/usage': { enabled: false, agents: {} },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/instance/catalog': {
        agents: [{ id: 'fixture', name: 'Fixture agent', defaultModel: 'gpt-6-astra' }],
        repositories: [
          { name: 'example/workspace', enabled: true, baseBranch: 'main' },
          { name: 'example/design-system', enabled: true, baseBranch: 'main' },
          { name: 'example/docs', enabled: true, baseBranch: 'main' },
        ],
      },
      '/api/queue/stats': { active: 2, waiting: 1, completed: 34, failed: 3 },
      '/api/stats/generating-plans': { count: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
      '/api/status': { status: 'ok' },
      ...dashboardResponses(attentionItems),
    };
    return pathname in responses
      ? route.fulfill({ json: responses[pathname] })
      : route.fulfill({ status: 503, json: { error: 'Unavailable in the dashboard responsive fixture' } });
  });
}

/** Both live sections have landed, so nothing is still a skeleton. */
async function openDashboard(page: Page, width: number, attentionItems = attention): Promise<void> {
  await page.setViewportSize({ width, height: 1200 });
  await fixture(page, attentionItems);
  await page.goto('/');
  await expect(page.getByTestId('happening-now-list')).toBeVisible();
  await expect(page.getByTestId('completed-list')).toBeVisible();
  await expect(page.getByTestId('historical-stats-section')).toBeVisible();
}

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  // The daily chart draws only once its container has been measured.
  await page.locator('.recharts-surface').first().waitFor({ state: 'visible' }).catch(() => undefined);
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', fullPage: true, path: path.join(directory, `${name}.png`) });
}

/** Every element wider than the viewport, named well enough to fix. */
async function horizontalOverflow(page: Page) {
  return page.evaluate(() => ({
    documentScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    wide: [...document.querySelectorAll('main *')]
      .filter(node => node.getBoundingClientRect().right > window.innerWidth + 1)
      .map(node => ({
        className: String(node.className).slice(0, 80),
        text: (node.textContent || '').slice(0, 40),
        right: Math.round(node.getBoundingClientRect().right),
      }))
      .slice(0, 5),
  }));
}

/** The four panes, and the phone's scope bar above them, in priority order. */
const PANES = ['needs-attention-panel', 'happening-now-section', 'completed-section', 'historical-stats-section'];
const SECTIONS = ['dashboard-scope-bar', ...PANES];

/** The scope bar and panes in the order the document lists them. */
async function sectionOrder(page: Page): Promise<string[]> {
  return page.evaluate(ids => [...document.querySelectorAll('[data-testid]')]
    .map(node => node.getAttribute('data-testid') as string)
    .filter(id => ids.includes(id)), SECTIONS);
}

type Box = { top: number; bottom: number; left: number; right: number; width: number };

/** Each named section's rounded bounding box, keyed by its test id. */
async function sectionBoxes(page: Page, ids: string[]): Promise<Record<string, Box>> {
  return page.evaluate(names => Object.fromEntries(names.map(id => {
    const { top, bottom, left, right, width } = (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).getBoundingClientRect();
    return [id, { top: Math.round(top), bottom: Math.round(bottom), left: Math.round(left), right: Math.round(right), width: Math.round(width) }];
  })), ids);
}

for (const width of [...NARROW_WIDTHS, ...WIDE_WIDTHS]) {
  test(`the dashboard has no horizontal overflow at ${width}px`, async ({ page }) => {
    await openDashboard(page, width);

    const overflow = await horizontalOverflow(page);
    expect(overflow.wide).toEqual([]);
    expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  });
}

for (const width of NARROW_WIDTHS) {
  test(`sections read top to bottom in priority order at ${width}px`, async ({ page }) => {
    await openDashboard(page, width);

    // What needs a person first, then what is running, then what happened,
    // then the background numbers.
    expect(await sectionOrder(page)).toEqual(SECTIONS);

    // One column: every section starts on the same left edge and spans it.
    const boxes = Object.values(await sectionBoxes(page, SECTIONS));
    expect(new Set(boxes.map(box => box.left)).size).toBe(1);
    expect(new Set(boxes.map(box => box.width)).size).toBe(1);

    await capture(page, `dashboard-responsive-${width}`);
  });
}

test('the wide layout keeps live work in the main column and the supporting panels beside it', async ({ page }) => {
  await openDashboard(page, 1440);

  const columns = await sectionBoxes(page, PANES);

  // Running work and completed work share the wide column, stacked.
  expect(columns['happening-now-section'].left).toBe(columns['completed-section'].left);
  expect(columns['happening-now-section'].width).toBe(columns['completed-section'].width);

  // Attention and stats share the narrow column, to the right of it.
  expect(columns['needs-attention-panel'].left).toBe(columns['historical-stats-section'].left);
  expect(columns['needs-attention-panel'].width).toBe(columns['historical-stats-section'].width);
  expect(columns['needs-attention-panel'].left).toBeGreaterThanOrEqual(columns['happening-now-section'].right);
  expect(columns['happening-now-section'].width).toBeGreaterThan(columns['needs-attention-panel'].width);

  await capture(page, 'dashboard-responsive-1440');
});

test('the wide layout spends no row on a page bar: the filter sits left of search and both columns hang off the global header', async ({ page }) => {
  await openDashboard(page, 1440);

  await expect(page.getByTestId('dashboard-scope-bar')).toBeHidden();
  await expect(page.getByTestId('summary-strip')).toHaveCount(0);
  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
    const header = rect('header[aria-label="Application toolbar"]');
    const filter = rect('[data-testid="header-scope-slot"] button');
    const search = rect('header input[aria-label="Search"]');
    return {
      headerMiddle: Math.round(header.top + header.height / 2),
      headerBottom: Math.round(header.bottom),
      filterMiddle: Math.round(filter.top + filter.height / 2),
      filterRight: Math.round(filter.right),
      searchLeft: Math.round(search.left),
      running: Math.round(rect('[data-testid="happening-now-section"]').top),
      attention: Math.round(rect('[data-testid="needs-attention-panel"]').top),
    };
  });

  // The filter is in the global toolbar, on its center line, immediately
  // left of search with nothing between them.
  expect(Math.abs(geometry.filterMiddle - geometry.headerMiddle)).toBeLessThanOrEqual(1);
  expect(geometry.searchLeft - geometry.filterRight).toBeGreaterThan(0);
  expect(geometry.searchLeft - geometry.filterRight).toBeLessThanOrEqual(8);
  // Both columns start on the global header's own rule.
  expect(geometry.running).toBe(geometry.headerBottom);
  expect(geometry.attention).toBe(geometry.headerBottom);
});

test('an empty attention list holds the right column instead of collapsing it', async ({ page }) => {
  await openDashboard(page, 1440, []);

  // Drawn, not removed: the section that triages work is the top module of the
  // right column at every count, including zero.
  await expect(page.getByTestId('needs-attention-panel')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Needs attention/ })).toHaveText('Needs attention (0)');
  await expect(page.getByTestId('needs-attention-empty')).toBeVisible();

  const boxes = await sectionBoxes(page, PANES);

  // One horizon per row across both columns: attention beside running work,
  // stats beside the completed feed.
  expect(boxes['needs-attention-panel'].top).toBe(boxes['happening-now-section'].top);
  expect(boxes['historical-stats-section'].top).toBe(boxes['completed-section'].top);
  // The supporting column is still one column, and stats are still under it.
  expect(boxes['historical-stats-section'].left).toBe(boxes['needs-attention-panel'].left);
  expect(boxes['historical-stats-section'].top).toBeGreaterThan(boxes['needs-attention-panel'].top);

  const overflow = await horizontalOverflow(page);
  expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  await capture(page, 'dashboard-responsive-1440-no-attention');
});

test('a completion without a score reserves no score column on mobile', async ({ page }) => {
  await openDashboard(page, 390);

  // The badge is rendered only where a score exists.
  await expect(page.getByTestId('completed-score')).toHaveCount(SCORED_OUTCOMES);

  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="completed-list"] > li')]
    .map(row => {
      const link = row.querySelector('a') as HTMLElement;
      const content = link.firstElementChild as HTMLElement;
      // The row's inner edge: where text may run to once padding is removed.
      const innerRight = link.getBoundingClientRect().right
        - parseFloat(window.getComputedStyle(link).paddingRight);
      return {
        scored: row.querySelector('[data-testid="completed-score"]') !== null,
        contentRight: Math.round(content.getBoundingClientRect().right),
        innerRight: Math.round(innerRight),
      };
    }));

  const scored = rows.find(row => row.scored);
  const unscored = rows.find(row => !row.scored);
  expect(scored).toBeDefined();
  expect(unscored).toBeDefined();

  // The unscored row's text runs all the way to the row's own inner edge; the
  // scored row's stops short to make room for the badge. A reserved but empty
  // score column would make the two stop on the same line.
  expect(unscored!.contentRight).toBe(unscored!.innerRight);
  expect(scored!.contentRight).toBeLessThan(scored!.innerRight);
  expect(unscored!.contentRight).toBeGreaterThan(scored!.contentRight);
});

test('a long title wraps to two lines while the secondary line gives way first', async ({ page }) => {
  await openDashboard(page, 320);

  const row = page.getByTestId('happening-now-list').locator('li').first();
  const title = row.getByText(LONG_TITLE);
  await expect(title).toBeVisible();

  const measured = await title.evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const style = window.getComputedStyle(node);
    return {
      lines: range.getClientRects().length,
      text: (node.textContent || '').trim(),
      clipped: node.scrollHeight > node.clientHeight + 1,
      // Truncation to a single line would show up as either of these.
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
    };
  });

  // It wrapped rather than being cut off on one line, and nothing was clipped.
  expect(measured.lines).toBeGreaterThan(1);
  expect(measured.lines).toBeLessThanOrEqual(2);
  expect(measured.text).toBe(LONG_TITLE);
  expect(measured.clipped).toBe(false);
  expect(measured.whiteSpace).not.toBe('nowrap');
  expect(measured.textOverflow).not.toBe('ellipsis');

  // The progress line is secondary, so it is the one held to a single line
  // even though its text is longer than the title's — and on a phone it is the
  // path inside it that gives way first, down to the file it names.
  await expect(row.getByText(SHORT_PROGRESS_LINE)).toBeVisible();
  await expect(row.getByText(LONG_PROGRESS_LINE)).toBeHidden();
  const detail = row.getByText(SHORT_PROGRESS_LINE).locator('xpath=..');
  expect(LONG_PROGRESS_LINE.length).toBeGreaterThan(LONG_TITLE.length);
  await expect(detail).toHaveClass(/line-clamp-1/);
  const detailBox = await detail.evaluate(node => ({
    height: node.getBoundingClientRect().height,
    lineHeight: parseFloat(window.getComputedStyle(node).lineHeight),
  }));
  // One line on screen, however many the text would take unclamped: the clamp
  // has to actually clip, which it does not if `block` wins the `display` it
  // is fighting the clamp for.
  expect(detailBox.height).toBeLessThanOrEqual(detailBox.lineHeight + 1);
  expect(measured.lines).toBeGreaterThan(1);

  const overflow = await horizontalOverflow(page);
  expect(overflow.wide).toEqual([]);
});

for (const width of NARROW_WIDTHS) {
  test(`a running item spends one metadata line, not four, at ${width}px`, async ({ page }) => {
    await openDashboard(page, width);

    const row = page.getByTestId('happening-now-list').locator('li').first();

    // Every row in the pane is running, so there is no status word to place:
    // the entities on the left, how long it has been on the right, and then
    // the title. A naive wrap used to spread four facts over three lines
    // before the title was even reached.
    const geometry = await row.evaluate(node => {
      const box = (selector: string) => {
        const rect = (node.querySelector(selector) as HTMLElement).getBoundingClientRect();
        return { top: Math.round(rect.top), left: Math.round(rect.left), right: Math.round(rect.right), middle: Math.round(rect.top + rect.height / 2) };
      };
      return {
        hasStatus: node.querySelector('[class*="sm:order-1"]') !== null,
        elapsed: box('[class*="sm:order-3"]'),
        entities: box('[class*="sm:order-2"]'),
        title: (node.querySelector('.line-clamp-2') as HTMLElement).getBoundingClientRect().top,
      };
    });

    expect(geometry.hasStatus).toBe(false);
    // Entities and elapsed share a centre line (the chips are taller than the
    // time, so tops differ), and the elapsed time is flush right of them.
    expect(geometry.entities.middle).toBe(geometry.elapsed.middle);
    expect(geometry.elapsed.left).toBeGreaterThan(geometry.entities.right);
    // The title follows on the next line.
    expect(geometry.title).toBeGreaterThan(geometry.entities.top);

    // The owner is dropped here for the same reason it is in the right rail.
    // `useInnerText` because the full slug is still in the DOM for wider
    // viewports, hidden by CSS rather than removed.
    await expect(row.getByTitle('example/workspace')).toHaveText('workspace', { useInnerText: true });

    // No typed separator survives to wrap onto a line of its own.
    expect(await page.getByTestId('happening-now-section').textContent()).not.toContain('•');
    expect(await page.getByTestId('completed-section').textContent()).not.toContain('•');
  });

  test(`no disclosure control crowds the elapsed time at ${width}px`, async ({ page }) => {
    await openDashboard(page, width);

    // The row is a link to its work, not an accordion. A chevron on its right
    // edge promised a fold the row does not have and left two pixels between
    // itself and the elapsed time it was crowding.
    const list = page.getByTestId('happening-now-list');
    await expect(list.getByRole('button')).toHaveCount(0);
    await expect(list.locator('[aria-expanded]')).toHaveCount(0);

    const row = list.locator('li').first();
    const clearance = await row.evaluate(node => {
      const link = node.querySelector('a') as HTMLElement;
      const elapsed = node.querySelector('[class*="sm:order-3"]') as HTMLElement;
      const padding = parseFloat(window.getComputedStyle(link).paddingRight);
      return Math.round(link.getBoundingClientRect().right - elapsed.getBoundingClientRect().right - padding);
    });
    // The elapsed time now ends on the row's own inner edge.
    expect(clearance).toBe(0);
  });

  test(`every section stacks its lines in the same order at ${width}px`, async ({ page }) => {
    await openDashboard(page, width);

    // Metadata first, time at the right end of the first line, then the
    // title. Three sections with three hierarchies made the reading plane
    // jump at every heading as the page scrolled.
    const schema = await page.evaluate(() => {
      const box = (node: Element) => {
        const rect = node.getBoundingClientRect();
        return {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          middle: Math.round(rect.top + rect.height / 2),
        };
      };
      const attentionRow = document.querySelector('[data-testid="needs-attention-panel"] li > div') as HTMLElement;
      const activeRow = document.querySelector('[data-testid="happening-now-list"] li') as HTMLElement;
      return {
        attention: {
          status: box(attentionRow.children[0]),
          time: box(attentionRow.children[1]),
          entities: box(attentionRow.children[2]),
          action: box(attentionRow.children[3]),
          title: box(attentionRow.querySelector('.line-clamp-2') as HTMLElement),
        },
        active: {
          time: box(activeRow.querySelector('[class*="sm:order-3"]') as HTMLElement),
          entities: box(activeRow.querySelector('[class*="sm:order-2"]') as HTMLElement),
          title: box(activeRow.querySelector('.line-clamp-2') as HTMLElement),
        },
      };
    });

    // A running row has no status word — every row in the pane is running —
    // so its entities take line one, opposite the time, and the title follows.
    expect(schema.active.entities.middle).toBe(schema.active.time.middle);
    expect(schema.active.time.left).toBeGreaterThan(schema.active.entities.right);
    expect(schema.active.title.top).toBeGreaterThan(schema.active.entities.top);

    // An attention row keeps its status, since it says why the item waits.
    // Line one: what it is, and how long it has been, at opposite ends.
    expect(schema.attention.status.top).toBe(schema.attention.time.top);
    expect(schema.attention.time.left).toBeGreaterThan(schema.attention.status.right);
    // Line two: the entities, starting on the row's own left edge.
    expect(schema.attention.entities.top).toBeGreaterThan(schema.attention.status.top);
    expect(schema.attention.entities.left).toBe(schema.attention.status.left);
    // Line three: the title.
    expect(schema.attention.title.top).toBeGreaterThan(schema.attention.entities.top);

    // The attention row's action is the right-hand end of line two, where the
    // completed feed puts its score. It is a 32px tap target beside a 20px chip,
    // so the two share a centre line rather than a top edge.
    expect(schema.attention.action.middle).toBe(schema.attention.entities.middle);
    expect(schema.attention.action.left).toBeGreaterThan(schema.attention.entities.right);
  });

  test(`the last pane clears the fixed bottom navigation at ${width}px`, async ({ page }) => {
    await openDashboard(page, width);

    const navigation = page.locator('.mobile-bottom-navigation');
    await expect(navigation).toBeVisible();
    await page.evaluate(() => {
      const scroller = document.querySelector('main') as HTMLElement;
      scroller.scrollTop = scroller.scrollHeight;
    });

    // Scrolled to the end, the chart and the metric row it belongs to are both
    // above the bar with a gap under them: content stopping exactly on the
    // bar's top rule reads as content the bar is cutting off.
    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
      return {
        stats: Math.round(rect('[data-testid="historical-stats-section"]').bottom),
        chart: Math.round(rect('[data-testid="daily-completions-chart"]').bottom),
        navigation: Math.round(rect('.mobile-bottom-navigation').top),
      };
    });
    expect(geometry.chart).toBeLessThan(geometry.navigation);
    expect(geometry.navigation - geometry.stats).toBeGreaterThanOrEqual(16);

    // The page scrolls inside `main`, so the end of the console is only ever
    // in a shot taken from the end of the scroll.
    await capture(page, `dashboard-responsive-${width}-end`);
  });

  test(`the repository filter is the whole title bar at ${width}px`, async ({ page }) => {
    await openDashboard(page, width);

    // No "Dashboard" beside it: the bottom tab says where you are, so a long
    // repository name gets the full row instead of being cut to fit half.
    const bar = page.getByTestId('dashboard-scope-bar');
    await expect(bar).toHaveText('All Repos');
    await bar.getByRole('button').click();
    await page.getByTestId('repo-item').filter({ hasText: 'design-system' }).click();
    await expect(bar).toHaveText('example/design-system (main)');

    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
      const [bar, button, label] = ['', ' button', ' button span.truncate'].map(part => rect(`[data-testid="dashboard-scope-bar"]${part}`));
      const labelNode = document.querySelector('[data-testid="dashboard-scope-bar"] button span.truncate') as HTMLElement;
      return {
        bar: bar.toJSON() as DOMRect, canvas: rect('main').top, buttonWidth: button.width, firstPane: rect('[data-testid="needs-attention-panel"]').top,
        offCenter: Math.abs((label.left + label.right) / 2 - (bar.left + bar.right) / 2),
        truncated: labelNode.scrollWidth > labelNode.clientWidth,
      };
    });
    // It is the first thing on the canvas, spans the row inside the 12px
    // rail, reads centered, and the panes start on its bottom rule.
    expect(geometry.bar.top).toBe(geometry.canvas);
    expect(Math.round(geometry.buttonWidth)).toBe(Math.round(geometry.bar.width) - 24);
    expect(geometry.offCenter).toBeLessThanOrEqual(12);
    expect(geometry.truncated).toBe(false);
    expect(Math.round(geometry.firstPane)).toBe(Math.round(geometry.bar.bottom));
    await capture(page, `dashboard-responsive-${width}-scope`);
  });
}

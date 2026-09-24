import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const now = Date.parse('2026-09-23T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const running = [
  { id: 'task:run-1', taskId: 'run-1', repository: 'example/workspace', issueNumber: 2479, prNumber: null, title: 'Rebuild the dashboard into five sections with a shared repository filter', state: 'claude_execution', phase: 'Implementing', progressLine: 'Editing propr-ui/src/components/Dashboard.tsx', createdAt: minutesAgo(26), updatedAt: minutesAgo(1) },
  { id: 'task:run-2', taskId: 'run-2', repository: 'example/workspace', issueNumber: 2480, prNumber: 2481, title: 'Fix PR #2481: keep the queue summary honest when no reason is known', state: 'post_processing', phase: 'Finishing up', progressLine: 'Pushing branch', createdAt: minutesAgo(14), updatedAt: minutesAgo(2) },
  { id: 'task:run-3', taskId: 'run-3', repository: 'example/design-system', issueNumber: 118, prNumber: null, title: 'Align the score badge with the outcome feed', state: 'processing', phase: 'Preparing', progressLine: null, createdAt: minutesAgo(9), updatedAt: minutesAgo(3) },
  { id: 'task:run-4', taskId: 'run-4', repository: 'example/workspace', issueNumber: 2455, prNumber: null, title: 'Cache repository icons across dashboard sections', state: 'claude_execution', phase: 'Implementing', progressLine: 'Running tests', createdAt: minutesAgo(7), updatedAt: minutesAgo(1) },
  { id: 'task:run-5', taskId: 'run-5', repository: 'example/docs', issueNumber: 61, prNumber: null, title: 'Document the dashboard data contracts', state: 'claude_execution', phase: 'Implementing', progressLine: null, createdAt: minutesAgo(4), updatedAt: minutesAgo(1) },
  { id: 'task:run-6', taskId: 'run-6', repository: 'example/docs', issueNumber: 62, prNumber: null, title: 'Explain the attention rules in the operations guide', state: 'processing', phase: 'Preparing', progressLine: null, createdAt: minutesAgo(2), updatedAt: minutesAgo(1) },
  // Seven, not six: one row over the visible five is simply drawn, so the
  // expand control only appears — and only has to be tested — past that.
  { id: 'task:run-7', taskId: 'run-7', repository: 'example/design-system', issueNumber: 119, prNumber: null, title: 'Unify the empty and unavailable states across panels', state: 'processing', phase: 'Preparing', progressLine: null, createdAt: minutesAgo(1), updatedAt: minutesAgo(1) },
];

const attention = [
  { id: 'task:blocked-1', category: 'blocked', kind: 'task_failed', taskId: 'blocked-1', repository: 'example/workspace', issueNumber: 2470, prNumber: null, title: 'Retry budget never applies to post-processing', state: 'failed', detail: 'Lint failed on propr-ui/src/api/dashboardApi.ts', since: minutesAgo(190) },
  { id: 'task:blocked-2', category: 'blocked', kind: 'task_action_required', taskId: 'blocked-2', repository: 'example/design-system', issueNumber: 117, prNumber: null, title: 'Choose between the compact and comfortable row density', state: 'action_required', detail: 'Waiting for a decision on row density', since: minutesAgo(95) },
  // A review decision carries the title of the run behind it, and where that
  // run recorded no title, the branch it works on. Neither row may fall back
  // to `Pull request #2469`, which is the chip beside it read twice.
  { id: 'plan-issue:31', category: 'decision', kind: 'plan_review', taskId: null, repository: 'example/workspace', issueNumber: 2468, prNumber: 2469, title: 'Cache repository icons across dashboard sections', state: 'under_review', detail: 'Pull request is awaiting review', since: minutesAgo(52) },
  { id: 'plan-issue:32', category: 'decision', kind: 'plan_review', taskId: null, repository: 'example/docs', issueNumber: 58, prNumber: 59, title: 'feature/icon-cache', state: 'under_review', detail: 'Pull request is awaiting review', since: minutesAgo(20) },
];

const outcomes = [
  // A merge is recorded against a plan issue, which has no title of its own:
  // the API names it after the run it merged rather than after its own chip.
  { id: 'plan-issue:30:merged', kind: 'merged', taskId: 'done-1', repository: 'example/workspace', issueNumber: 2466, prNumber: 2467, title: 'Show corrective operator messages verbatim in the goal timeline', detail: 'Pull request merged', planIssueStatus: 'merged', score: null, occurredAt: minutesAgo(18) },
  { id: 'task:done-1:completed', kind: 'completed', taskId: 'done-1', repository: 'example/workspace', issueNumber: 2466, prNumber: 2467, title: 'Show corrective operator messages verbatim in the goal timeline', detail: null, planIssueStatus: 'merged', score: 9, occurredAt: minutesAgo(46) },
  { id: 'task:done-2:failed', kind: 'failed', taskId: 'done-2', repository: 'example/design-system', issueNumber: 115, prNumber: null, title: 'Tighten the reference chip contrast', detail: 'Typecheck failed', planIssueStatus: null, score: null, occurredAt: minutesAgo(88) },
  { id: 'task:done-3:completed', kind: 'completed', taskId: 'done-3', repository: 'example/docs', issueNumber: 57, prNumber: 60, title: 'Describe the recorded-spend metric', detail: null, planIssueStatus: null, score: 7, occurredAt: minutesAgo(140) },
  { id: 'task:done-4:completed', kind: 'completed', taskId: 'done-4', repository: 'example/workspace', issueNumber: 2460, prNumber: null, title: 'Reduce duplicate startup reads on the dashboard route', detail: null, planIssueStatus: null, score: 8, occurredAt: minutesAgo(300) },
  { id: 'task:done-5:cancelled', kind: 'cancelled', taskId: 'done-5', repository: 'example/workspace', issueNumber: 2452, prNumber: null, title: 'Prototype a percentage progress bar', detail: 'Cancelled by operator', planIssueStatus: null, score: null, occurredAt: minutesAgo(420) },
];

/**
 * The shell around the dashboard.
 *
 * The fixture signs a user in and serves Agent Tank usage so the left
 * navigation renders whole — nav, the USAGE telemetry widget and the account
 * block — instead of ending at Settings above a column of dead space. The user
 * is a plain member on purpose: the admin-only banners (onboarding, missing
 * default model, Agent Tank detection) would otherwise push the dashboard
 * itself down the page and out of the capture.
 */
const user = {
  id: 'preview-user',
  login: 'operator',
  username: 'operator',
  displayName: 'Dana Okonkwo',
  email: null,
  avatarUrl: null,
  role: 'member',
  permissions: [],
  authorizationSource: 'local',
};

const agentTankUsage = {
  enabled: true,
  agents: {
    claude: {
      name: 'claude',
      usage: {
        session: { percent: 34, resetsIn: '2h 10m' },
        weeklyAll: { percent: 61, resetsIn: '3d 4h' },
        weeklySonnet: { percent: 22, resetsIn: '3d 4h' },
      },
    },
    codex: {
      name: 'codex',
      usage: {
        fiveHour: { percentUsed: 12, resetsIn: '1h 05m' },
        weekly: { percentUsed: 47, resetsIn: '4d 2h' },
      },
    },
  },
};

const dashboardResponses = (
  attentionItems: typeof attention,
  runningItems: typeof running,
): Record<string, unknown> => ({
  '/api/dashboard/summary': {
    repository: 'all',
    needsAttention: attentionItems.length,
    running: runningItems.length,
    queued: 2,
    completedRecently: 4,
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
    running: runningItems,
    queued: [],
    queue: { queuedCount: 2, reason: 'All agents are busy' },
    counts: { running: runningItems.length, queued: 2 },
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

async function fixture(
  page: Page,
  attentionItems: typeof attention = attention,
  runningItems: typeof running = running,
) {
  await page.clock.install({ time: now });
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      '/api/auth/user': user,
      '/api/config/agent-tank/usage': agentTankUsage,
      '/api/tasks': { tasks: [], total: 0 },
      '/api/instance/catalog': {
        agents: [{ id: 'fixture', name: 'Fixture agent', defaultModel: 'gpt-6-astra' }],
        repositories: [
          { name: 'example/workspace', enabled: true, baseBranch: 'main' },
          { name: 'example/design-system', enabled: true, baseBranch: 'main' },
          { name: 'example/docs', enabled: true, baseBranch: 'main' },
        ],
      },
      '/api/queue/stats': { active: 6, waiting: 2, completed: 34, failed: 3 },
      '/api/stats/generating-plans': { count: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
      '/api/status': { status: 'ok' },
      ...dashboardResponses(attentionItems, runningItems),
    };
    return pathname in responses
      ? route.fulfill({ json: responses[pathname] })
      : route.fulfill({ status: 503, json: { error: 'Unavailable in the dashboard layout fixture' } });
  });
}

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  // The daily chart draws after its container is measured.
  await page.locator('.recharts-surface').first().waitFor({ state: 'visible' }).catch(() => undefined);
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', fullPage: true, path: path.join(directory, `${name}.png`) });
}

test('desktop shows every section with running work in the main column', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await fixture(page);
  await page.goto('/');

  await expect(page.getByTestId('header-scope-slot').getByRole('button', { name: /All Repos/ })).toBeVisible();
  await expect(page.getByTestId('dashboard-scope-bar')).toBeHidden();
  await expect(page.getByTestId('summary-strip')).toHaveCount(0);
  await expect(page.getByTestId('needs-attention-panel')).toBeVisible();
  await expect(page.getByTestId('happening-now-section')).toContainText('Implementing');
  await expect(page.getByTestId('queue-summary')).toContainText('All agents are busy');
  await expect(page.getByTestId('recent-outcomes-section')).toContainText('Merged');
  // One word per metric label: `RECORDED SPEND` does not fit a third of this
  // column, and a heading cut to `RECORDED SP…` reads as a broken grid.
  await expect(page.getByTestId('historical-stats-section')).toContainText('Spend');
  await expect(page.getByTestId('historical-stats-section')).not.toContainText('RECORDED SP');

  // Five active rows before the list is expanded.
  await expect(page.getByTestId('happening-now-list').locator('li')).toHaveCount(5);

  // The navigation column is whole: nav, then telemetry, then the account.
  const sidebar = page.locator('aside').first();
  await expect(sidebar.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(sidebar.getByText('Usage')).toBeVisible();
  await expect(sidebar.getByText('Dana Okonkwo')).toBeVisible();

  // Every action in the attention column starts on the same vertical line.
  const actionLefts = await page.getByTestId('needs-attention-panel').getByRole('link', { name: /^(Open|Review)\b/ })
    .evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().left)));
  expect(actionLefts.length).toBeGreaterThan(1);
  expect(new Set(actionLefts).size).toBe(1);

  // The repository chip in the narrow column drops its owner so all three
  // chips fit the line whole; nothing in the column is cut off.
  const attentionPanel = page.getByTestId('needs-attention-panel');
  await expect(attentionPanel.getByTitle('example/workspace').first()).toHaveText('workspace');
  const clipped = await attentionPanel.locator('.truncate').evaluateAll(nodes =>
    nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent ?? ''));
  expect(clipped).toEqual([]);

  // One footer closes the running list: the queue summary and the expand
  // control share the bar instead of the link floating above it.
  const footer = page.getByTestId('happening-now-footer');
  await expect(footer.getByTestId('queue-summary')).toBeVisible();
  await expect(footer.getByRole('button', { name: 'Show 2 more' })).toBeVisible();

  await capture(page, 'dashboard-desktop');

  await footer.getByRole('button', { name: 'Show 2 more' }).click();
  await expect(page.getByTestId('happening-now-list').locator('li')).toHaveCount(7);
  await expect(footer.getByRole('button', { name: 'Show fewer' })).toBeVisible();
});

test('the queue footer floors the running pane when the column beside it is taller', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  // One running task against three attention items: the pane is sized by the
  // column beside it, not by its own single row. The task has been going for
  // four hours, which is the duration that used to print as `240m 00s`.
  await fixture(page, attention.slice(0, 3), [{ ...running[0], createdAt: minutesAgo(240) }]);
  await page.goto('/');

  await expect(page.getByTestId('happening-now-list').locator('li')).toHaveCount(1);

  const geometry = await page.evaluate(() => {
    const box = (id: string) => (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).getBoundingClientRect();
    const section = box('happening-now-section');
    const footer = box('happening-now-footer');
    const row = (document.querySelector('[data-testid="happening-now-list"] li') as HTMLElement).getBoundingClientRect();
    return {
      slack: Math.round(footer.top - row.bottom),
      floorGap: Math.round(section.bottom - footer.bottom),
      paneHeight: Math.round(section.height),
      outcomesTop: Math.round(box('recent-outcomes-section').top),
      footerBottom: Math.round(footer.bottom),
    };
  });

  // The bar closes the pane: nothing of the pane is left below it, and the
  // rule under it is the top of the next section.
  expect(geometry.floorGap).toBe(0);
  expect(geometry.outcomesTop).toBeGreaterThanOrEqual(geometry.footerBottom);
  // The empty space is above the bar, in the list area, rather than below it:
  // this is the 260px hole the bar used to hang over.
  expect(geometry.paneHeight).toBeGreaterThan(300);
  expect(geometry.slack).toBeGreaterThan(100);

  // A review row says what is being reviewed. `Pull request #2469` under a
  // `PR #2469` chip is the chip read twice.
  const panel = page.getByTestId('needs-attention-panel');
  await expect(panel).toContainText('Cache repository icons across dashboard sections');
  await expect(panel).not.toContainText('Pull request #');

  // Four hours reads as four hours, not as a count of 240 minutes.
  const list = page.getByTestId('happening-now-list');
  await expect(list).toContainText('4h 00m');
  await expect(list).not.toContainText('240m');

  await capture(page, 'dashboard-desktop-short-running-list');
});

test('an empty attention list keeps the panel in place with an all-clear line', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await fixture(page, []);
  await page.goto('/');

  await expect(page.getByTestId('happening-now-section')).toBeVisible();

  // The triage panel holds the top of the right column whatever the count is.
  const panel = page.getByTestId('needs-attention-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading')).toHaveText('Needs attention (0)');
  await expect(page.getByTestId('needs-attention-empty'))
    .toHaveText('All tasks operational — no attention required');

  const geometry = await page.evaluate(() => Object.fromEntries(
    ['needs-attention-panel', 'happening-now-section', 'recent-outcomes-section', 'historical-stats-section'].map(id => {
      const rect = (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).getBoundingClientRect();
      return [id, { top: Math.round(rect.top), bottom: Math.round(rect.bottom) }];
    }),
  ));

  // Row one starts on one horizon and row two starts on one horizon, so the
  // rule between them is a single line across both columns rather than a step.
  expect(geometry['needs-attention-panel'].top).toBe(geometry['happening-now-section'].top);
  expect(geometry['historical-stats-section'].top).toBe(geometry['recent-outcomes-section'].top);
  // Stats stay in the second tier; triage keeps the top of the rail.
  expect(geometry['historical-stats-section'].top)
    .toBeGreaterThan(geometry['needs-attention-panel'].bottom - 1);

  await capture(page, 'dashboard-desktop-no-attention');
});

test('the historical chart carries a scale rather than seven unlabelled shapes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await fixture(page);
  await page.goto('/');
  await expect(page.getByTestId('daily-completions-chart')).toBeVisible();
  await page.locator('.recharts-surface').first().waitFor({ state: 'visible' });

  // Height means nothing without a number attached to it: the fixture's
  // busiest day is 8 completions, so the top gridline says 8 and the baseline
  // says 0. Without them the tallest point could be 8 or 800.
  const chart = page.getByTestId('daily-completions-chart');
  const ticks = chart.locator('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value');
  await expect(ticks).toHaveCount(2);
  expect((await ticks.allTextContents()).map(text => text.trim()).sort()).toEqual(['0', '8']);

  // A line, not a row of bars: a trend over days is a continuous quantity.
  await expect(chart.locator('.recharts-area-curve')).toBeVisible();
  await expect(chart.locator('.recharts-bar')).toHaveCount(0);
  // Both gridlines are drawn, and dashed so they stay behind the data.
  const grid = chart.locator('.recharts-cartesian-grid-horizontal line');
  await expect(grid).toHaveCount(2);
  expect(await grid.first().getAttribute('stroke-dasharray')).toBe('3 3');

  // The marker for the latest day is filled and ringed, and it is plotted on
  // the right edge of the plot area: without a margin the size of its own
  // radius, half of it hangs past the vertical that the period toggle and the
  // analytics link sit on.
  const markers = chart.locator('.recharts-area-dots circle');
  const lastMarker = await markers.last().boundingBox();
  const plot = await chart.boundingBox();
  const railRight = await page.getByTestId('historical-stats-section')
    .locator('a', { hasText: 'Full analytics' })
    .evaluate(node => Math.round(node.getBoundingClientRect().right));
  expect(lastMarker).not.toBeNull();
  expect(Math.round(lastMarker!.x + lastMarker!.width)).toBeLessThanOrEqual(Math.round(plot!.x + plot!.width));
  expect(Math.round(lastMarker!.x + lastMarker!.width)).toBeLessThanOrEqual(railRight);
});

test('the dashboard fits a 320px viewport without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 1200 });
  await fixture(page);
  await page.goto('/');

  await expect(page.getByTestId('dashboard-scope-bar')).toBeVisible();
  await expect(page.getByTestId('needs-attention-panel')).toBeVisible();
  await expect(page.getByTestId('happening-now-section')).toBeVisible();

  const overflow = await page.evaluate(() => ({
    documentScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    wide: [...document.querySelectorAll('main *')]
      .filter(node => node.getBoundingClientRect().right > window.innerWidth + 1)
      .map(node => ({ cls: node.className, text: (node.textContent || '').slice(0, 40), right: Math.round(node.getBoundingClientRect().right), parent: (node.parentElement?.className || '').slice(0, 80) }))
      .slice(0, 5),
  }));
  expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  expect(overflow.wide).toEqual([]);
  await capture(page, 'dashboard-mobile');
});

test('the repository filter narrows every section and survives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture(page);
  const requested: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/dashboard/') || url.pathname === '/api/stats/dashboard') {
      requested.push(`${url.pathname}?${url.searchParams.get('repository')}`);
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('happening-now-section')).toBeVisible();

  await page.getByRole('button', { name: /All Repos/ }).click();
  await page.getByTestId('repo-item').filter({ hasText: 'docs' }).click();

  await expect(page).toHaveURL(/repository=example%2Fdocs/);
  await expect
    .poll(() => ['/api/dashboard/attention', '/api/dashboard/active', '/api/dashboard/outcomes', '/api/stats/dashboard']
      .every(pathname => requested.includes(`${pathname}?example/docs`)))
    .toBe(true);

  await page.reload();
  await expect(page.getByRole('button', { name: /docs/ })).toBeVisible();
});

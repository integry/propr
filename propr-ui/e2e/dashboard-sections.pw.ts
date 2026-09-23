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
];

const attention = [
  { id: 'task:blocked-1', category: 'blocked', kind: 'task_failed', taskId: 'blocked-1', repository: 'example/workspace', issueNumber: 2470, prNumber: null, title: 'Retry budget never applies to post-processing', state: 'failed', detail: 'Lint failed on propr-ui/src/api/dashboardApi.ts', since: minutesAgo(190) },
  { id: 'task:blocked-2', category: 'blocked', kind: 'task_action_required', taskId: 'blocked-2', repository: 'example/design-system', issueNumber: 117, prNumber: null, title: 'Choose between the compact and comfortable row density', state: 'action_required', detail: 'Waiting for a decision on row density', since: minutesAgo(95) },
  { id: 'plan-issue:31', category: 'decision', kind: 'plan_review', taskId: null, repository: 'example/workspace', issueNumber: 2468, prNumber: 2469, title: null, state: 'under_review', detail: 'Pull request is awaiting review', since: minutesAgo(52) },
  { id: 'plan-issue:32', category: 'decision', kind: 'plan_review', taskId: null, repository: 'example/docs', issueNumber: 58, prNumber: 59, title: null, state: 'under_review', detail: 'Pull request is awaiting review', since: minutesAgo(20) },
];

const outcomes = [
  { id: 'plan-issue:30:merged', kind: 'merged', taskId: 'done-1', repository: 'example/workspace', issueNumber: 2466, prNumber: 2467, title: null, detail: 'Pull request merged', planIssueStatus: 'merged', score: null, occurredAt: minutesAgo(18) },
  { id: 'task:done-1:completed', kind: 'completed', taskId: 'done-1', repository: 'example/workspace', issueNumber: 2466, prNumber: 2467, title: 'Show corrective operator messages verbatim in the goal timeline', detail: null, planIssueStatus: 'merged', score: 9, occurredAt: minutesAgo(46) },
  { id: 'task:done-2:failed', kind: 'failed', taskId: 'done-2', repository: 'example/design-system', issueNumber: 115, prNumber: null, title: 'Tighten the reference chip contrast', detail: 'Typecheck failed', planIssueStatus: null, score: null, occurredAt: minutesAgo(88) },
  { id: 'task:done-3:completed', kind: 'completed', taskId: 'done-3', repository: 'example/docs', issueNumber: 57, prNumber: 60, title: 'Describe the recorded-spend metric', detail: null, planIssueStatus: null, score: 7, occurredAt: minutesAgo(140) },
  { id: 'task:done-4:completed', kind: 'completed', taskId: 'done-4', repository: 'example/workspace', issueNumber: 2460, prNumber: null, title: 'Reduce duplicate startup reads on the dashboard route', detail: null, planIssueStatus: null, score: 8, occurredAt: minutesAgo(300) },
  { id: 'task:done-5:cancelled', kind: 'cancelled', taskId: 'done-5', repository: 'example/workspace', issueNumber: 2452, prNumber: null, title: 'Prototype a percentage progress bar', detail: 'Cancelled by operator', planIssueStatus: null, score: null, occurredAt: minutesAgo(420) },
];

const dashboardResponses = (attentionItems: typeof attention): Record<string, unknown> => ({
  '/api/dashboard/summary': {
    repository: 'all',
    needsAttention: attentionItems.length,
    running: running.length,
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
    running,
    queued: [],
    queue: { queuedCount: 2, reason: 'All agents are busy' },
    counts: { running: running.length, queued: 2 },
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

async function fixture(page: Page, attentionItems: typeof attention = attention) {
  await page.clock.install({ time: now });
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
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
      ...dashboardResponses(attentionItems),
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

  await expect(page.getByTestId('summary-strip')).toBeVisible();
  await expect(page.getByTestId('summary-needs-attention')).toHaveAttribute('data-emphasis', 'true');
  await expect(page.getByTestId('needs-attention-panel')).toBeVisible();
  await expect(page.getByTestId('happening-now-section')).toContainText('Implementing');
  await expect(page.getByTestId('queue-summary')).toContainText('All agents are busy');
  await expect(page.getByTestId('recent-outcomes-section')).toContainText('Merged');
  await expect(page.getByTestId('historical-stats-section')).toContainText('Recorded spend');

  // Five active rows before the list is expanded.
  await expect(page.getByTestId('happening-now-list').locator('li')).toHaveCount(5);
  await capture(page, 'dashboard-desktop');

  await page.getByRole('button', { name: 'Show 1 more' }).click();
  await expect(page.getByTestId('happening-now-list').locator('li')).toHaveCount(6);
});

test('an empty attention list removes the panel from the desktop DOM', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await fixture(page, []);
  await page.goto('/');

  await expect(page.getByTestId('happening-now-section')).toBeVisible();
  await expect(page.getByTestId('needs-attention-panel')).toHaveCount(0);
  await expect(page.getByTestId('summary-needs-attention')).toHaveAttribute('data-emphasis', 'false');
  await capture(page, 'dashboard-desktop-no-attention');
});

test('the dashboard fits a 320px viewport without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 1200 });
  await fixture(page);
  await page.goto('/');

  await expect(page.getByTestId('summary-strip')).toBeVisible();
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
    .poll(() => ['/api/dashboard/summary', '/api/dashboard/attention', '/api/dashboard/active', '/api/dashboard/outcomes', '/api/stats/dashboard']
      .every(pathname => requested.includes(`${pathname}?example/docs`)))
    .toBe(true);

  await page.reload();
  await expect(page.getByRole('button', { name: /docs/ })).toBeVisible();
});

/**
 * The Analytics timeframe selector.
 *
 * One control scopes every section, so these checks are about the control
 * itself: which variant each width gets, that a phone header never overflows,
 * and that a choice reaches every endpoint and the URL. The suite runs
 * against stubbed HTTP, like the dashboard layout suites.
 */

import { expect, test, type Page } from '@playwright/test';
import { capture, fixture } from './dashboard-sections.fixture';

const dayKeys = (days: number): string[] => Array.from({ length: days }, (_, index) =>
  new Date(Date.parse('2026-09-23T00:00:00Z') - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10));

/** Each timeframe answers with different numbers, so a stale section would show. */
const SCALE: Record<string, number> = { '24h': 1, '7d': 3, '30d': 10, '90d': 24, '1y': 60, all: 80 };
const DAYS: Record<string, number> = { '24h': 2, '7d': 8, '30d': 31, '90d': 91, '1y': 366, all: 400 };

async function stubAnalytics(page: Page, requests: string[] = []) {
  await page.route('**/api/stats/{tasks,repositories,overview}*', route => {
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}${url.search}`);
    const period = url.searchParams.get('period') ?? '30d';
    const scale = SCALE[period] ?? 10;
    if (url.pathname === '/api/stats/tasks') {
      return route.fulfill({ json: {
        dailyCounts: dayKeys(DAYS[period] ?? 31).map((date, index) => ({ date, count: (index * 7 + scale) % 9 })),
        statusDistribution: [
          { status: 'completed', count: 8 * scale },
          { status: 'failed', count: scale },
          { status: 'processing', count: Math.max(1, Math.round(scale / 3)) },
        ],
        avgProcessingTime: [],
        summary: { total: 9 * scale + Math.max(1, Math.round(scale / 3)), completed: 8 * scale, failed: scale },
      } });
    }
    if (url.pathname === '/api/stats/repositories') {
      return route.fulfill({ json: { repositories: [
        { repository: 'example/workspace', total: 6 * scale, completed: 5 * scale, failed: scale, inProgress: 0, successRate: 83.3 },
        { repository: 'example/design-system', total: 3 * scale, completed: 3 * scale, failed: 0, inProgress: 0, successRate: 100 },
        { repository: 'example/docs', total: scale, completed: scale, failed: 0, inProgress: 0, successRate: 100 },
      ] } });
    }
    return route.fulfill({ json: {
      tasks: { completed: 8 * scale, planned: 0, pr_iterations_avg: 1.4, merged_prs: 7 * scale, total_followups: scale },
      usage: { total_tokens: 420_000 * scale, total_cost_usd: 1.242 * scale, models: { 'claude-opus-5-5': 5 * scale, 'gpt-5.6': 3 * scale } },
      model_usage: [
        { model: 'claude-opus-5-5', tasks: 5 * scale, tokens: 310_000 * scale, cost_usd: 0.94 * scale },
        { model: 'gpt-5.6', tasks: 3 * scale, tokens: 110_000 * scale, cost_usd: 0.302 * scale },
      ],
      system: { repos_indexed: 3 },
    } });
  });
}

async function openAnalytics(page: Page, width: number, search = '', requests: string[] = []) {
  await fixture(page, { width, height: 900 });
  await stubAnalytics(page, requests);
  await page.goto(`/analytics${search}`);
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();
}

/** Lets the activity chart finish its entry animation under the installed clock. */
async function captureSettled(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await page.clock.runFor(2_000);
  await capture(page, name);
}

const horizontalOverflow = (page: Page) => page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('phones get a native select with the full labels and no horizontal overflow', async ({ page }) => {
  await openAnalytics(page, 320);
  const select = page.getByRole('combobox', { name: 'Analytics timeframe' });
  await expect(select).toBeVisible();
  await expect(select).toHaveValue('30d');
  await expect(page.getByRole('group', { name: 'Analytics timeframe' })).toBeHidden();
  await expect(page.getByRole('heading', { name: /Repository performance/ })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await select.selectOption('7d');
  await expect(page).toHaveURL(/\/analytics\?period=7d$/);
  await expect(page.getByText('Aggregate activity across every repository · Last 7 days')).toBeVisible();
  await expect(page.getByText('design-system')).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await captureSettled(page, 'analytics-timeframe-mobile');
});

test('wider screens get the segmented control, and a choice reaches every section and the URL', async ({ page }) => {
  const requests: string[] = [];
  await openAnalytics(page, 1280, '', requests);
  const group = page.getByRole('group', { name: 'Analytics timeframe' });
  await expect(group).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Analytics timeframe' })).toBeHidden();
  await expect(group.getByRole('button')).toHaveText(['24h', '7d', '30d', '90d', '1y', 'All']);
  await expect(group.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: /Repository performance/ })).toBeVisible();

  requests.length = 0;
  await group.getByRole('button', { name: 'Last 7 days' }).click();
  await expect(page).toHaveURL(/\/analytics\?period=7d$/);
  await expect(group.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Aggregate activity across every repository · Last 7 days')).toBeVisible();
  await expect.poll(() => [...new Set(requests)].sort()).toEqual([
    '/api/stats/overview?period=7d',
    '/api/stats/repositories?period=7d',
    '/api/stats/tasks?period=7d',
  ]);
  await expect(page.getByText('design-system')).toBeVisible();
  await captureSettled(page, 'analytics-timeframe-desktop');

  await group.getByRole('button', { name: 'Last 30 days' }).click();
  await expect(page).toHaveURL(/\/analytics$/);
});

test('the URL restores a timeframe and an unknown one falls back to the default', async ({ page }) => {
  await openAnalytics(page, 1280, '?period=90d');
  await expect(page.getByRole('button', { name: 'Last 90 days' })).toHaveAttribute('aria-pressed', 'true');

  await page.goto('/analytics?period=bogus');
  await expect(page.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Aggregate activity across every repository · Last 30 days')).toBeVisible();
});

test('the console keeps the toolbar steady: search does not move and the scope shows locked', async ({ page }) => {
  await openAnalytics(page, 1280);
  const scope = page.getByTestId('analytics-repository-scope');
  await expect(scope).toBeVisible();
  await expect(scope).toHaveText('All Repos');
  await expect(page.getByTestId('metric-total-tasks')).toHaveText('93');
  await expect(page.getByTestId('metric-success-rate')).toHaveText('88.9%');
  await expect(page.getByTestId('metric-tokens')).toHaveText('4.2M');
  await expect(page.getByTestId('metric-spend')).toHaveText('$12.42');
  await expect(page.getByTestId('model-breakdown-table').getByRole('row')).toHaveText([
    /Model/, /Claude Opus 5\.5/, /GPT-5\.6/,
  ]);
  const analyticsSearch = await page.getByTestId('header-search').boundingBox();
  const analyticsScope = await page.getByTestId('header-scope-slot').boundingBox();

  await page.goto('/');
  await expect(page.getByTestId('header-scope-slot').getByRole('button', { name: /All Repos/ })).toBeVisible();
  const dashboardSearch = await page.getByTestId('header-search').boundingBox();
  const dashboardScope = await page.getByTestId('header-scope-slot').boundingBox();
  expect(analyticsSearch).toEqual(dashboardSearch);
  expect(analyticsScope?.x).toBe(dashboardScope?.x);
  expect(analyticsScope?.width).toBe(dashboardScope?.width);
});

test('the 1080p console fills the canvas without cards', async ({ page }) => {
  await fixture(page, { width: 1920, height: 1080 });
  await stubAnalytics(page);
  await page.goto('/analytics?period=7d');
  await expect(page.getByText('design-system')).toBeVisible();
  // White canvas, hairline rules, and nothing rounded and shadowed floating on it.
  expect(await page.locator('main .shadow-sm, main .shadow, main .rounded-xl').count()).toBe(0);
  await expect(page.getByTestId('analytics-primary-pane')).toHaveCSS('border-right-width', '1px');
  await captureSettled(page, 'analytics-console-1080p');
});

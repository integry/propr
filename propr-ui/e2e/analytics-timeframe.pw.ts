/**
 * The Analytics timeframe selector.
 *
 * One control scopes every section, so these checks are about the control
 * itself: which variant each width gets, that a phone header never overflows,
 * and that a choice reaches every endpoint and the URL. The suite runs
 * against stubbed HTTP, like the dashboard layout suites.
 */

import { expect, test, type Page } from '@playwright/test';
import { capture, captureTarget, fixture } from './dashboard-sections.fixture';

const dayKeys = (days: number): string[] => Array.from({ length: days }, (_, index) =>
  new Date(Date.parse('2026-09-23T00:00:00Z') - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10));

/** Each timeframe answers with different numbers, so a stale section would show. */
const SCALE: Record<string, number> = { '24h': 1, '7d': 3, '30d': 10, '90d': 24, '1y': 60, all: 80 };
const DAYS: Record<string, number> = { '24h': 2, '7d': 8, '30d': 31, '90d': 91, '1y': 366, all: 400 };

async function stubAnalytics(page: Page, requests: string[] = []) {
  await page.route('**/api/stats/{tasks,repositories,overview,review-scores}*', route => {
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
    if (url.pathname === '/api/stats/review-scores') {
      const figures = (prs: number, first: number, final: number, merged: number, cost: number | null) => ({
        prs_scored: prs, first_score: { mean: first, median: Math.round(first), n: prs }, final_score: { mean: final, n: prs },
        cycles_to_goal: { mean: 1.8, n: Math.max(1, Math.round(prs / 2)), attempted: prs },
        merge_rate: { value: merged / prs, merged, n: prs }, cost_per_merged_pr: { usd: cost, n: cost === null ? 0 : merged },
        score_delta: { mean: final - first, n: prs }, runs_to_merge: { mean: cost === null ? null : 2.4, n: cost === null ? 0 : merged },
      });
      return route.fulfill({ json: { period, repository: 'all', prs_scored: 6 * scale, scores_recorded: 14 * scale, models: [
        { implementer_model: 'claude-opus-5-5', implementer_agent: 'claude', ...figures(4 * scale, 6.4, 8.6, 3 * scale, 1.84) },
        { implementer_model: 'gpt-5.6', implementer_agent: 'codex', ...figures(2 * scale, 5.9, 8.1, scale, null) },
      ] } });
    }
    return route.fulfill({ json: {
      tasks: { completed: 8 * scale, planned: 0, pr_iterations_avg: 1.4, merged_prs: 7 * scale, total_followups: scale },
      usage: { total_tokens: 420_000 * scale, input_tokens: 315_000 * scale, output_tokens: 105_000 * scale, total_cost_usd: 1.242 * scale, models: { 'claude-opus-5-5': 5 * scale, 'gpt-5.6': 3 * scale } },
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
  await expect(page.getByRole('heading', { name: /Activity · Last 7 days/ })).toBeVisible();
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
  // A month labels every day with room for one, and steps evenly from today where there is not.
  await expect(page.getByTestId('activity-date-label').last()).toHaveText('23');
  await captureSettled(page, 'analytics-activity-month');

  requests.length = 0;
  await group.getByRole('button', { name: 'Last 7 days' }).click();
  await expect(page).toHaveURL(/\/analytics\?period=7d$/);
  await expect(group.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: /Activity · Last 7 days/ })).toBeVisible();
  await expect.poll(() => [...new Set(requests)].sort()).toEqual([
    '/api/stats/overview?period=7d',
    '/api/stats/repositories?period=7d',
    '/api/stats/review-scores?period=7d',
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
  await expect(page.getByRole('heading', { name: /Activity · Last 30 days/ })).toBeVisible();
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

test('history is quiet: only today is teal, the scale has a midline, and the right pane accounts for tokens', async ({ page }) => {
  await openAnalytics(page, 1440, '?period=7d');
  await expect(page.getByText('design-system')).toBeVisible();

  const chart = page.getByTestId('activity-chart');
  const bars = chart.locator('.recharts-bar-rectangle path');
  await expect(bars.first()).toBeVisible();
  const fills = await bars.evaluateAll(paths => paths.map(path => path.getAttribute('fill')));
  // Seven settled days with tasks, then today; an empty day draws no bar.
  expect(fills.slice(0, -1).every(fill => fill === '#CBD5E1')).toBe(true);
  expect(fills.at(-1)).toBe('#14B8A6');
  // The busiest day is 8, so the scale reads 0, a dashed midline at 4, and 8.
  const ticks = chart.locator('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value');
  await expect(ticks).toHaveCount(3);
  expect((await ticks.allTextContents()).map(text => Number(text.trim())).sort((a, b) => a - b)).toEqual([0, 4, 8]);
  // The midline is a grid line, drawn behind the bars, and lighter than the edge rules.
  const strokes = await chart.locator('.recharts-cartesian-grid-horizontal line').evaluateAll(lines =>
    lines.map(line => `${line.getAttribute('stroke')} ${line.getAttribute('stroke-dasharray')}`).sort());
  expect(strokes).toEqual(['#E2E8F0 3 3', '#E2E8F0 3 3', '#F1F5F9 3 3']);
  const gridBeforeBars = await chart.locator('svg.recharts-surface').evaluate(svg => {
    const nodes = Array.from(svg.querySelectorAll('.recharts-cartesian-grid, .recharts-bar'));
    return nodes.findIndex(node => node.classList.contains('recharts-bar')) === nodes.length - 1;
  });
  expect(gridBeforeBars).toBe(true);

  await expect(page.getByTestId('analytics-timeframe-summary')).toHaveText('Aggregate activity across all repositories');

  const tokens = page.getByTestId('token-consumption');
  await expect(tokens.getByTestId('token-row-input')).toContainText('945K');
  await expect(tokens.getByTestId('token-row-output')).toContainText('315K');

  // Tasks, tokens and cost share one width.
  const widths = await page.getByTestId('model-breakdown-table').locator('th').evaluateAll(cells =>
    cells.slice(1).map(cell => Math.round(cell.getBoundingClientRect().width)));
  expect(new Set(widths).size).toBe(1);
  await captureSettled(page, 'analytics-quiet-history');
});

test('a week labels every day under its bar, and each day owns its full-height column', async ({ page }) => {
  await openAnalytics(page, 1440, '?period=7d');
  await expect(page.getByText('design-system')).toBeVisible();

  const chart = page.getByTestId('activity-chart');
  // Eight days, eight labels: the weekday over the day, Sep 16 through today.
  const labels = chart.getByTestId('activity-date-label');
  await expect(labels).toHaveCount(8);
  expect(await labels.allTextContents()).toEqual([
    'WedSep 16', 'Thu17', 'Fri18', 'Sat19', 'Sun20', 'Mon21', 'Tue22', 'Wed23',
  ]);

  // Each label sits under its own bar, not on a rail of its own.
  const bars = chart.locator('.recharts-bar-rectangle path');
  const barBoxes = await bars.evaluateAll(paths => paths.map(path => path.getBoundingClientRect())
    .map(box => ({ center: box.x + box.width / 2, width: box.width })));
  const labelCenters = await labels.evaluateAll(texts => texts.map(text => {
    const box = text.getBoundingClientRect();
    return box.x + box.width / 2;
  }));
  // Wide bars, not stilts.
  expect(barBoxes.every(box => box.width >= 32)).toBe(true);
  // Days with tasks have bars; every bar has its date centred under it.
  for (const bar of barBoxes) {
    expect(labelCenters.some(center => Math.abs(center - bar.center) < 2)).toBe(true);
  }

  // Hovering anywhere in a day's column lights a ceiling-to-baseline track behind its bar.
  // The first grid holds the baseline and maximum rules, so it spans the plot top to bottom.
  const plot = await chart.locator('.recharts-cartesian-grid').first().boundingBox();
  const lastBar = barBoxes.at(-1)!;
  await page.mouse.move(lastBar.center, plot!.y + 4);
  const track = chart.locator('.recharts-tooltip-cursor');
  await expect(track).toBeVisible();
  const trackBox = await track.boundingBox();
  // Within the grid lines' stroke.
  expect(trackBox!.height).toBeGreaterThanOrEqual(plot!.height - 2);
  expect(trackBox!.width).toBeGreaterThan(lastBar.width);
  await expect(page.getByText('Sep 23: 7 tasks')).toBeVisible();
  await captureSettled(page, 'analytics-activity-week');
});

test('repository and model rows drill down to the filtered lists', async ({ page }) => {
  await openAnalytics(page, 1440, '?period=7d');
  const repositories = page.getByTestId('repository-performance-table');
  await expect(repositories.getByText('workspace')).toBeVisible();

  await expect(repositories.getByRole('link', { name: 'Tasks in example/workspace', exact: true }))
    .toHaveAttribute('href', '/tasks?repository=example%2Fworkspace');
  await expect(repositories.getByRole('link', { name: '3 failed tasks in example/workspace' }))
    .toHaveAttribute('href', '/tasks?repository=example%2Fworkspace&status=failed');
  await expect(page.getByTestId('model-breakdown-table').getByRole('link', { name: 'LLM log for gpt-5.6' }))
    .toHaveAttribute('href', '/llm-logs?model=gpt-5.6');

  const row = repositories.locator('tbody tr').first();
  await expect(row).toHaveCSS('cursor', 'pointer');
  await row.hover();
  await expect(row).toHaveCSS('background-color', 'rgb(248, 250, 252)');
  await captureSettled(page, 'analytics-row-drill-down');

  await row.getByRole('cell').last().click();
  await expect(page).toHaveURL(/\/tasks\?repository=example%2Fworkspace$/);
});

test('the agent efficacy matrix shows one figure per cell, denominators on hover and unknowns as a dash', async ({ page }) => {
  await openAnalytics(page, 1440);
  const pane = page.locator('section', { has: page.getByRole('heading', { name: /Agent efficacy by model/ }) });
  const rows = pane.getByTestId('review-quality-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Claude Opus 5.5');
  await expect(rows.first().getByTestId('review-quality-delta')).toHaveText('+2.2 ▲');
  await expect(rows.first().getByTestId('review-quality-final')).toHaveAttribute('title', 'Mean over 40 PRs');
  await expect(rows.nth(1).getByTestId('review-quality-runs')).toHaveText('—');
  await expect(pane.getByText(/n=\d/)).toHaveCount(0);
  // Every column fits the pane: nothing scrolls sideways.
  const table = pane.getByTestId('review-quality-table');
  expect(await table.evaluate(node => node.parentElement!.scrollWidth - node.parentElement!.clientWidth)).toBeLessThanOrEqual(0);
  await captureTarget(pane, 'analytics-review-quality');
  await captureSettled(page, 'analytics-review-quality-page');
});

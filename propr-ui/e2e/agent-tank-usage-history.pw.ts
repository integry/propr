/**
 * Agent Tank usage history: the Analytics usage chart and the sidebar's
 * per-metric overlay, against stubbed HTTP like the dashboard layout suites.
 */

import { expect, test, type Page, type Route } from '@playwright/test';
import { fixture, now, user } from './dashboard-sections.fixture';

const HOUR = 3_600_000;
const PREVIEWS = '../.propr/previews';

const usage = { enabled: true, agents: {
  claude: { name: 'claude', usage: { session: { percent: 34, resetsIn: '2h 10m' }, weeklyAll: { percent: 61, resetsIn: '3d 4h' }, weeklyFable: { percent: 44, resetsIn: '3d 4h' } } },
  codex: { name: 'codex', usage: { fiveHour: { percentUsed: 12, resetsIn: '1h 05m' }, weekly: { percentUsed: 47, resetsIn: '4d 2h' } } },
  antigravity: { name: 'antigravity', usage: { models: [
    { model: 'Gemini · Weekly Limit Remaining', group: 'Gemini', cycle: 'weekly', percentUsed: 22, resetsIn: '120h 4m' },
    { model: 'Gemini 4 Argon Weekly Limit', group: 'Gemini 4 Argon', cycle: 'weekly', percentUsed: 38, resetsIn: '88h 30m' },
  ] } },
} };

/** A quota that climbs within each period and drops back to zero at every reset. */
function sawtooth(periodHours: number, peak: number, until: number, hours: number, resetOffsetHours = 0) {
  const points = [];
  for (let t = until - hours * HOUR; t <= until; t += Math.max(HOUR / 4, (hours * HOUR) / 240)) {
    const phase = (((t / HOUR + resetOffsetHours) % periodHours) + periodHours) % periodHours / periodHours;
    const wobble = Math.sin(t / (2.7 * HOUR)) * 3;
    points.push({ t: new Date(t).toISOString(), percent: Math.max(0, Math.min(100, Math.round((phase * peak + wobble) * 10) / 10)) });
  }
  return points;
}

const SERIES: Record<string, Array<{ key: string; label: string; cycle: string; period: number; peak: number; offset: number }>> = {
  claude: [
    { key: 'session', label: 'Current session', cycle: 'session', period: 5, peak: 78, offset: 2.2 },
    { key: 'weeklyAll', label: 'Current week (all models)', cycle: 'weekly', period: 168, peak: 92, offset: 92 },
    { key: 'weeklyFable', label: 'Current week (Fable)', cycle: 'weekly', period: 168, peak: 66, offset: 92 },
  ],
  codex: [
    { key: 'fiveHour', label: '5h limit', cycle: 'five_hour', period: 5, peak: 41, offset: 3.9 },
    { key: 'weekly', label: 'Weekly limit', cycle: 'weekly', period: 168, peak: 70, offset: 70 },
  ],
  antigravity: [
    { key: 'model:Gemini · Weekly Limit Remaining', label: 'Gemini · Weekly Limit Remaining', cycle: 'weekly', period: 168, peak: 35, offset: 48 },
    { key: 'model:Gemini 4 Argon Weekly Limit', label: 'Gemini 4 Argon Weekly Limit', cycle: 'weekly', period: 168, peak: 58, offset: 80 },
  ],
};

/** Three more Antigravity pools, taking the answer past the eight-color palette. */
const EXTRA_POOLS = ['Claude Fable 5.1', 'Gemini 4 Flash', 'GPT-OSS'].map((name, index) => ({
  key: `model:${name} Weekly Limit`, label: `${name} Weekly Limit`, cycle: 'weekly', period: 168, peak: 20 + index * 12, offset: 30 + index * 25,
}));

async function stubHistory(page: Page, requests: URL[] = [], extra: typeof SERIES = {}) {
  // History is real installation data, so it is read by an agent manager, not
  // the fixture's demo viewer (who sees only the synthetic usage feed).
  await page.route('**/api/auth/demo-mode', route => route.fulfill({ json: { demoMode: false } }));
  await page.route('**/api/auth/user', route => route.fulfill({ json: { ...user, permissions: ['instance.manage_agents'] } }));
  await page.route('**/api/config/agent-tank/usage', route => route.fulfill({ json: usage }));
  await page.route('**/api/config/agent-tank/history?**', (route: Route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const since = Number(url.searchParams.get('since'));
    const until = Number(url.searchParams.get('until') ?? now);
    const hours = (until - since) / HOUR;
    const agents = url.searchParams.get('agent')?.split(',') ?? Object.keys(SERIES);
    const metric = url.searchParams.get('metric');
    return route.fulfill({ json: { enabled: true, source: 'propr', retentionDays: 15, agents: agents.map(agent => ({
      agent,
      series: [...(SERIES[agent] ?? []), ...(extra[agent] ?? [])].filter(entry => !metric || entry.key === metric).map(entry => ({
        key: entry.key, label: entry.label, model: null, cycle: entry.cycle,
        points: sawtooth(entry.period, entry.peak, until, hours, entry.offset),
      })),
    })) } });
  });
  await page.route('**/api/stats/{tasks,repositories,overview,review-scores}*', route => {
    const pathname = new URL(route.request().url()).pathname;
    const bodies: Record<string, unknown> = {
      '/api/stats/tasks': { dailyCounts: [], statusDistribution: [], avgProcessingTime: [], summary: { total: 0, completed: 0, failed: 0 } },
      '/api/stats/repositories': { repositories: [] },
      '/api/stats/review-scores': { period: '30d', repository: 'all', prs_scored: 0, scores_recorded: 0, models: [] },
      '/api/stats/overview': { tasks: { completed: 0, planned: 0, pr_iterations_avg: 0, merged_prs: 0, total_followups: 0 },
        usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0, total_cost_usd: 0, models: {} }, model_usage: [], system: { repos_indexed: 0 } },
    };
    return route.fulfill({ json: bodies[pathname] ?? {} });
  });
}

test('the Analytics page plots every agent and metric, and narrows to a few', async ({ page }) => {
  await fixture(page, { width: 1440, height: 900 });
  const requests: URL[] = [];
  await stubHistory(page, requests);
  await page.goto('/analytics');

  const pane = page.getByTestId('analytics-usage-history');
  await expect(pane.getByTestId('agent-usage-history-chart').locator('.recharts-line')).toHaveCount(7);
  await expect(pane.getByRole('button', { name: /Antigravity · Gemini 4 Argon Weekly/ })).toBeVisible();

  await pane.getByRole('button', { name: 'Codex', exact: true }).click();
  await expect(pane.getByTestId('agent-usage-history-chart').locator('.recharts-line')).toHaveCount(5);
  await expect(page).toHaveURL(/usageHideAgents=codex/);
  await pane.getByRole('button', { name: 'Show all' }).click();

  await pane.getByTestId('agent-usage-history-chart').hover({ position: { x: 900, y: 120 } });
  await expect(page.locator('.recharts-tooltip-wrapper')).toContainText('Claude · Session');
  await page.screenshot({ path: `${PREVIEWS}/analytics-usage-desktop.png`, clip: await pane.boundingBox() ?? undefined });
});

test('metrics past the eight-hue palette are all plotted, repeated hues dashed', async ({ page }) => {
  await fixture(page, { width: 1440, height: 900 });
  await stubHistory(page, [], { antigravity: EXTRA_POOLS });
  await page.goto('/analytics');

  const pane = page.getByTestId('analytics-usage-history');
  const lines = pane.getByTestId('agent-usage-history-chart').locator('.recharts-line-curve');
  await expect(lines).toHaveCount(10);
  await expect(lines.nth(8)).toHaveAttribute('stroke-dasharray', /\d/);
  await expect(lines.nth(9)).toHaveAttribute('stroke-dasharray', /\d/);
  await expect(pane.getByText(/not plotted/)).toHaveCount(0);

  await pane.getByTestId('agent-usage-history-chart').hover({ position: { x: 900, y: 120 } });
  await expect(page.locator('.recharts-tooltip-wrapper')).toContainText('GPT-OSS Weekly');
  await page.screenshot({ path: `${PREVIEWS}/analytics-usage-all-metrics.png`, clip: await pane.boundingBox() ?? undefined });

  await pane.getByRole('button', { name: /^Claude · Fable/ }).click();
  await expect(lines).toHaveCount(9);
  await pane.getByRole('button', { name: 'Table' }).click();
  await expect(pane.getByTestId('agent-usage-history-table').getByRole('row')).toHaveCount(1 + 9);
  await expect(pane.getByTestId('agent-usage-history-table').getByRole('row', { name: /GPT-OSS/ })).toBeVisible();
});

test('the Analytics usage chart fits a phone', async ({ page }) => {
  await fixture(page, { width: 390, height: 844 });
  await stubHistory(page);
  await page.goto('/analytics?usageRange=3d');

  const pane = page.getByTestId('analytics-usage-history');
  await expect(pane.getByTestId('agent-usage-history-chart').locator('.recharts-line')).toHaveCount(7);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  await pane.evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `${PREVIEWS}/analytics-usage-mobile.png` });
});

test('hovering a sidebar metric charts its last two periods', async ({ page }) => {
  await fixture(page, { width: 1440, height: 900 });
  const requests: URL[] = [];
  await stubHistory(page, requests);
  await page.goto('/analytics');

  const sidebarUsage = page.locator('aside, nav').getByRole('button', { name: /^Claude/ }).first();
  await sidebarUsage.click();
  const session = page.getByRole('button', { name: /^Session/ }).first();
  await session.hover();
  const overlay = page.getByRole('dialog', { name: 'Claude · Session usage history' });
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText('Last 10 hours');
  await expect(overlay.getByTestId('usage-metric-history-chart').locator('.recharts-area')).toHaveCount(1);
  const query = requests.find(url => url.searchParams.get('metric') === 'session')!;
  expect(Number(query.searchParams.get('until')) - Number(query.searchParams.get('since'))).toBe(10 * HOUR);

  await overlay.getByTestId('usage-metric-history-chart').hover({ position: { x: 200, y: 60 } });
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${PREVIEWS}/sidebar-usage-overlay-desktop.png`, clip: { x: 0, y: 380, width: 640, height: 520 } });

  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
});

test('tapping a weekly metric in the mobile usage sheet charts two weeks', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await fixture(page, { width: 390, height: 844 });
  const requests: URL[] = [];
  await stubHistory(page, requests);
  await page.goto('/analytics');

  await page.getByRole('button', { name: 'More' }).tap();
  await page.getByRole('button', { name: /API & quota usage/ }).tap();
  const sheet = page.getByRole('dialog', { name: 'API & quota usage' });
  await expect(sheet.getByText('Gemini 4 Argon', { exact: true })).toBeVisible();
  // The Argon pool's only window row, under its own sub-header.
  const argon = sheet.getByRole('button', { name: /^Weekly\s*38%/ });
  await argon.tap();

  const overlay = page.getByRole('dialog', { name: /Antigravity · Gemini 4 Argon Weekly Limit usage history/ });
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText('Last 14 days');
  const query = requests.find(url => url.searchParams.get('metric') === 'model:Gemini 4 Argon Weekly Limit')!;
  expect(Number(query.searchParams.get('until')) - Number(query.searchParams.get('since'))).toBe(14 * 24 * HOUR);
  await expect(overlay.getByRole('button', { name: 'Close usage history' })).toBeVisible();
  await expect(overlay.getByTestId('usage-metric-history-chart')).toBeVisible();
  // A tap inside the overlay must not dismiss the sheet behind it.
  await overlay.getByTestId('usage-metric-history-chart').tap();
  await expect(sheet).toBeVisible();
  await expect(overlay).toBeVisible();

  // Screenshots reset touch emulation, so capture last.
  await page.screenshot({ path: `${PREVIEWS}/sidebar-usage-overlay-mobile.png` });
  await context.close();
});

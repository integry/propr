import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const now = Date.parse('2026-09-11T12:00:00Z');
const tasks = [
  ...Array.from({ length: 6 }, (_, index) => ({
    id: `layout-update-${index}`, repository: 'example/workspace', issueNumber: 42, prNumber: 73,
    title: index === 0 ? 'New Issue: Keep task history readable when resizing the desktop workspace' : `Followup: Review checkpoint ${index} and preserve nested navigation`,
    status: ['processing', 'completed', 'failed', 'cancelled', 'pending', 'awaiting_review'][index],
    createdAt: new Date(now - (index + 1) * 3_600_000).toISOString(),
    completedAt: new Date(now - (index + 1) * 3_600_000 + 32 * 60_000).toISOString(),
    llmProvider: 'openai', model: 'gpt-6-astra', critiqueScore: index === 1 ? 9 : null,
  })),
  {
    id: 'layout-long-title', repository: 'example/desktop-workspace-with-long-repository-name',
    title: 'New Issue: Support configuration/desktop/workspaces/a-very-long-unbroken-configuration-filename.json in the task history',
    issueNumber: 86, status: 'completed', createdAt: '2026-07-10T10:00:00Z', completedAt: '2026-07-10T10:38:00Z',
    llmProvider: 'openai', model: 'a-long-model-identifier-for-desktop-layout-verification', critiqueScore: 8,
  },
];

async function fixture(page: Page, platform?: 'macos' | 'linux') {
  await page.clock.install({ time: now });
  if (platform) await page.addInitScript(platform => {
    const profile = { id: 'layout-fixture', name: 'Preview workspace', kind: 'remote' as const, baseUrl: 'https://fixture.example.test' };
    window.__PROPR_DESKTOP__ = {
      isDesktop: true, platform,
      app: { onDeepLink: () => () => undefined },
      profiles: { list: async () => [profile], getActiveId: async () => profile.id, setActiveId: async () => undefined, save: async () => undefined, remove: async () => undefined },
      connection: { probe: async () => ({ status: 'ready' }) },
      authentication: { authenticate: async () => undefined },
      discovery: { supported: false, discover: async () => [] },
      localSetup: { supported: false, setup: async () => profile },
      externalBrowser: { open: async () => undefined },
    };
  }, platform);
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      '/api/tasks': { tasks, total: tasks.length },
      '/api/instance/catalog': { agents: [{ id: 'fixture', name: 'Fixture agent', defaultModel: 'gpt-6-astra' }], repositories: [{ name: 'example/workspace' }] },
      '/api/queue/stats': { active: 1, waiting: 1, completed: 3, failed: 1 },
      '/api/stats/generating-plans': { count: 0 },
      '/api/stats/tasks': { summary: { total: 7, completed: 3, failed: 1, active: 1, waiting: 1 }, dailyCounts: [], statusDistribution: [], avgProcessingTime: [] },
      '/api/stats/overview': { usage: { total_cost_usd: 0, total_tokens: 0, models: {} }, tasks: { completed: 3, planned: 7, pr_iterations_avg: 1, merged_prs: 1, total_followups: 5 }, system: { repos_indexed: 2 } },
      '/api/stats/repositories': { repositories: [{ repository: 'example/workspace', total: 7, completed: 3, failed: 1, inProgress: 1, successRate: 43 }] },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return pathname in responses ? route.fulfill({ json: responses[pathname] }) : route.fulfill({ status: 503, json: { error: 'Unavailable in privacy-safe layout fixture' } });
  });
}

for (const platform of ['macos', 'linux'] as const) {
  for (const width of [880, 1024, 1280]) {
    // The dashboard no longer embeds the task list; it has its own sections.
    for (const route of ['/tasks']) {
      test(`${platform} ${width}px Tasks stays readable and navigable`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 880 ? 620 : 820 });
        await fixture(page, platform);
        await page.goto(route);
        const table = page.locator('.desktop-task-list table');
        await expect(table).toBeVisible();
        await expect(table.getByRole('columnheader', { name: 'Actions' })).toHaveCount(0);
        await table.getByRole('button', { name: 'Show 2 older updates...' }).focus();
        await page.keyboard.press('Enter');
        await expect(table.getByRole('button', { name: /Review checkpoint 5/ })).toBeVisible();
        expect(new URL(page.url()).pathname).toBe(route);

        const measurements = await table.evaluate(element => ({
          fits: element.getBoundingClientRect().right <= window.innerWidth,
          overflows: [...element.querySelectorAll('td')].filter(cell => cell.clientWidth && cell.scrollWidth > cell.clientWidth + 1).map(cell => cell.className),
          times: [...element.querySelectorAll('.task-metadata > div')].map(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            return { lines: range.getClientRects().length, width: range.getBoundingClientRect().width, available: node.clientWidth };
          }),
        }));
        expect(measurements.fits).toBe(true);
        expect(await table.locator('.task-summary').first().evaluate(node => node.clientWidth)).toBeGreaterThan(200);
        expect(measurements.overflows).toEqual([]);
        for (const timestamp of measurements.times) {
          expect(timestamp.lines).toBe(1);
          expect(timestamp.width).toBeLessThanOrEqual(timestamp.available);
        }
        await table.getByRole('button', { name: 'Keep task history readable when resizing the desktop workspace' }).scrollIntoViewIfNeeded();
        if (process.env.PROPR_CAPTURE_PREVIEWS && platform === 'macos') {
          const directory = path.resolve('../.propr/previews');
          await mkdir(directory, { recursive: true });
          await page.screenshot({ path: path.join(directory, `task-list-tasks-${width}.png`) });
          if (route === '/tasks' && width === 1280) {
            const longTitleRow = table.getByRole('button', { name: /Support configuration/ }).locator('xpath=ancestor::tr');
            await longTitleRow.screenshot({ path: path.join(directory, 'task-list-long-title.png') });
          }
        }
        const title = table.getByRole('button', { name: 'Keep task history readable when resizing the desktop workspace' });
        await title.focus();
        await expect(title).toBeFocused();
        await expect(title).toHaveCSS('outline-style', 'solid');
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/tasks\/layout-update-0$/);
      });
    }
  }
}

test('web retains its arrow column and mobile cards', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/tasks');
  await expect(page.getByRole('table').getByRole('columnheader', { name: 'Actions' })).toHaveCount(1);
  await expect(page.locator('.desktop-task-list')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('table')).not.toBeVisible();
  await expect(page.getByText('Keep task history readable when resizing the desktop workspace').first()).toBeVisible();
});

test('desktop task list does not present an empty state while its scoped read is pending', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await fixture(page, 'macos');
  let releaseTasks!: () => void;
  const tasksPending = new Promise<void>(resolve => { releaseTasks = resolve; });
  await page.route('**/api/tasks*', async route => {
    await tasksPending;
    await route.fulfill({ json: { tasks: [], total: 0 } });
  });

  await page.goto('/tasks');
  await expect(page.getByText('Loading tasks...')).toBeVisible();
  await expect(page.getByText(/No tasks found/)).toHaveCount(0);

  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    const directory = path.resolve('../.propr/previews');
    await mkdir(directory, { recursive: true });
    await page.screenshot({ animations: 'disabled', path: path.join(directory, 'tasks-initial-loading.png') });
  }

  releaseTasks();
  await expect(page.getByText(/No tasks found/)).toBeVisible();
  await expect(page.getByText('Loading tasks...')).toHaveCount(0);
});

import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { openSearchFromMenu } from './mobile-menu-search.fixture';

const repos = [
  { id: 'mcptest-main', name: 'integry/mcptest', baseBranch: 'main', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
  { id: 'mcptest-release', name: 'integry/mcptest', baseBranch: 'release', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
  // No explicit branch: must stay distinguishable from the release entry listed before it.
  { id: 'mcptest-default', name: 'integry/mcptest', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
  { id: 'propr', name: 'integry/propr', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
];

async function capturePreview(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}.png` });
}

async function stubApis(page: Page, viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport);
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': {
        id: 'preview-user', login: 'preview', username: 'preview', displayName: 'Preview User', email: null, avatarUrl: null,
        role: 'admin', permissions: ['instance.manage_settings'], authorizationSource: 'local',
      },
      '/api/config/repos': { success: true, repos_to_monitor: repos },
      '/api/instance/catalog': { repositories: repos, agents: [] },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/planner/drafts': { drafts: [], total: 0, page: 1, limit: 5, hasMore: false },
      '/api/repositories/indexing-status': { repositories: [] },
      '/api/repos/chat/messages': { messages: [] },
      '/api/notifications/unread-count': { unreadCount: 0 },
    };
    return path in responses
      ? route.fulfill({ json: responses[path] })
      : route.fulfill({ status: 503, json: { error: 'Optional API unavailable in global search test' } });
  });
}

async function searchFor(page: Page, term: string) {
  const input = page.getByRole('combobox', { name: 'Search' });
  await input.fill(term);
  const palette = page.getByTestId('global-search-palette');
  await expect(palette.getByRole('option')).toHaveCount(3);
  return { input, palette, preview: palette.getByTestId('global-search-preview') };
}

test('a repository search result opens the repository by default', async ({ page }) => {
  await stubApis(page);
  await page.goto('/');
  const { input, preview } = await searchFor(page, 'mcptest');
  await input.press('ArrowDown');
  await expect(preview.getByRole('button', { name: 'Open repository' })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible();
  await capturePreview(page, 'global-search-repository-actions');

  await input.press('Enter');
  // The repository is its own URL; three entries track it, so the URL names the branch.
  await expect(page).toHaveURL(/\/repositories\/integry\/mcptest\?branch=release$/);
  // The highlighted entry is the release branch, so that branch entry is the one selected.
  await expect(page.getByRole('region', { name: 'Settings for integry/mcptest', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select integry/mcptest', exact: true }).nth(1)).toHaveAttribute('aria-pressed', 'true');
  await capturePreview(page, 'global-search-repository-opened');
});

test('a repository\'s tasks open only through the explicit Tasks button', async ({ page }) => {
  await stubApis(page);
  await page.goto('/');
  const { preview } = await searchFor(page, 'mcptest');
  await preview.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\?repository=integry%2Fmcptest$/);
});

test('a repository without an explicit branch opens its own entry, not a same-name branch entry', async ({ page }) => {
  await stubApis(page);
  await page.goto('/');
  const { input, preview } = await searchFor(page, 'mcptest');
  await input.press('ArrowDown');
  await input.press('ArrowDown');
  await expect(preview.getByText('default', { exact: true })).toBeVisible();
  await input.press('Enter');
  // `?branch=` (empty) names the entry that tracks no explicit branch.
  await expect(page).toHaveURL(/\/repositories\/integry\/mcptest\?branch=$/);
  const entries = page.getByRole('button', { name: 'Select integry/mcptest', exact: true });
  await expect(entries.nth(2)).toHaveAttribute('aria-pressed', 'true');
  await expect(entries.nth(1)).toHaveAttribute('aria-pressed', 'false');
});

test('narrow screens keep an explicit Tasks action while the preview pane is hidden', async ({ browser }) => {
  // Below `md` the toolbar is hidden; search opens from the ProPR menu and the preview pane is not shown.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await stubApis(page, { width: 390, height: 844 });
  await page.goto('/');
  const { input } = await openSearchFromMenu(page);
  await input.fill('mcptest');
  const palette = page.getByTestId('global-search-palette');
  await expect(palette.getByRole('option')).toHaveCount(3);
  await expect(palette.getByTestId('global-search-preview')).toBeHidden();
  const tasks = palette.getByRole('button', { name: 'Tasks for mcptest →' });
  await expect(tasks).toBeInViewport({ ratio: 1 });
  await capturePreview(page, 'global-search-repository-narrow-tasks');
  await tasks.tap();
  await expect(page).toHaveURL(/\/tasks\?repository=integry%2Fmcptest$/);
  await context.close();
});

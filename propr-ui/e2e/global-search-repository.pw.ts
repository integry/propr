import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const repos = [
  { id: 'mcptest-main', name: 'integry/mcptest', baseBranch: 'main', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
  { id: 'mcptest-release', name: 'integry/mcptest', baseBranch: 'release', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
  { id: 'propr', name: 'integry/propr', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
];

async function capturePreview(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}.png` });
}

async function stubApis(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await expect(palette.getByRole('option')).toHaveCount(2);
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
  await expect(page).toHaveURL(/\/repositories$/);
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

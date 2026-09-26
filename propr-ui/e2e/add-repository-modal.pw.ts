import { expect, test, type Page } from '@playwright/test';

const admin = {
  id: 'preview-admin',
  login: 'preview-admin',
  username: 'preview-admin',
  displayName: 'Preview Admin',
  email: null,
  avatarUrl: null,
  role: 'admin',
  permissions: ['instance.manage_settings'],
  authorizationSource: 'local',
};

interface ConfigWrite {
  repos_to_monitor: Array<{ name: string; baseBranch?: string }>;
}

async function stubRepositoryApis(page: Page, onConfigWrite?: (body: ConfigWrite) => void): Promise<void> {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === '/api/auth/demo-mode') return route.fulfill({ json: { demoMode: false } });
    if (pathname === '/api/auth/user') return route.fulfill({ json: admin });
    if (pathname === '/api/config/repos') {
      if (request.method() === 'POST') {
        onConfigWrite?.(request.postDataJSON() as ConfigWrite);
        return route.fulfill({ json: { success: true, repos_to_monitor: [] } });
      }
      return route.fulfill({ json: { repos_to_monitor: [] } });
    }
    if (pathname === '/api/github/repos') {
      return route.fulfill({ json: { repos: ['integry/propr', 'integry/second-repository'] } });
    }
    if (pathname === '/api/github/repos/integry/propr/branches') {
      return route.fulfill({
        json: {
          branches: ['main', 'release/2026.09', 'desktop-dialog-validation'],
          defaultBranch: 'main',
        },
      });
    }
    if (pathname === '/api/repositories/indexing-status') {
      return route.fulfill({ json: { repositories: [] } });
    }
    if (pathname === '/api/user/repo-preferences') {
      return route.fulfill({ json: { preferences: {} } });
    }
    if (pathname === '/api/notifications/unread-count') {
      return route.fulfill({ json: { unreadCount: 0 } });
    }
    if (pathname === '/api/notifications/preferences') {
      return route.fulfill({
        json: { preferences: {}, quietHours: { start: null, end: null, timezone: 'UTC' }, badgeEnabled: true },
      });
    }

    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unavailable in Add Repository browser test' }),
    });
  });
}

test('bounds the dialog and keeps every control keyboard-reachable at 900x500 with scaled text', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 });
  let configWrites = 0;
  await stubRepositoryApis(page, () => { configWrites += 1; });
  await page.goto('/repositories');
  await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });

  const addRepositoryLauncher = page.getByRole('button', { name: '+ Add Repository' });
  await addRepositoryLauncher.click();
  const dialog = page.getByRole('dialog', { name: 'Add Repository' });
  const body = dialog.getByTestId('add-repository-modal-body');
  const footer = dialog.getByTestId('add-repository-modal-footer');
  const title = dialog.getByRole('heading', { name: 'Add Repository' });
  const close = dialog.getByRole('button', { name: 'Close Add Repository' });
  const repository = dialog.getByLabel('Repository *');
  const alias = dialog.getByLabel('Alias (optional)');
  const branch = dialog.getByRole('button', { name: 'Base Branch (optional)' });
  const followup = dialog.getByRole('checkbox', { name: /Automatic CI follow-up/ });
  const visualPreviews = dialog.getByRole('checkbox', { name: /Visual previews/ });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const submit = dialog.getByRole('button', { name: 'Add Repository', exact: true });

  await expect(repository).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(repository).toBeFocused();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(900);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(500);

  const scrollMetrics = await body.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  const titleBefore = await title.boundingBox();
  const footerBefore = await footer.boundingBox();

  await page.keyboard.type('integry/propr');
  await page.keyboard.press('Tab');
  await expect(alias).toBeFocused();
  await page.keyboard.type('Production');
  await page.keyboard.press('Tab');
  await expect(branch).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(followup).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(visualPreviews).toBeFocused();
  await page.keyboard.press('Space');
  await expect(visualPreviews).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Images' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Videos' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Preview instructions (optional)')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(submit).toBeFocused();
  await expect(submit).toBeInViewport();

  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(submit).toBeFocused();

  expect((await title.boundingBox())?.y).toBe(titleBefore?.y);
  expect((await footer.boundingBox())?.y).toBe(footerBefore?.y);
  expect(await body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  for (let step = 0; step < 7; step += 1) {
    await page.keyboard.press('Shift+Tab');
  }
  await expect(branch).toBeFocused();
  await page.keyboard.press('Enter');
  const branchFilter = dialog.getByRole('combobox', { name: 'Base Branch (optional)' });
  await expect(branchFilter).toBeFocused();
  await page.keyboard.type('release');
  const releaseBranch = dialog.getByRole('option', { name: 'release/2026.09' });
  await expect(releaseBranch).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(releaseBranch).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', {
    name: 'Base Branch (optional) release/2026.09',
    exact: true,
  })).toBeVisible();
  await expect(submit).toBeInViewport();

  await submit.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(addRepositoryLauncher).toBeFocused();
  await expect.poll(() => configWrites).toBe(1);
});

test('does not add the repository when Enter is pressed directly in the branch filter', async ({ page }) => {
  const configWrites: ConfigWrite[] = [];
  await stubRepositoryApis(page, body => { configWrites.push(body); });
  await page.goto('/repositories');

  await page.getByRole('button', { name: '+ Add Repository' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Repository' });
  await dialog.getByLabel('Repository *').fill('integry/propr');
  await dialog.getByRole('button', { name: 'Base Branch (optional)' }).click();

  const branchFilter = dialog.getByRole('combobox', { name: 'Base Branch (optional)' });
  const releaseBranch = dialog.getByRole('option', { name: 'release/2026.09' });
  await branchFilter.fill('release');
  await expect(releaseBranch).toBeVisible();
  await branchFilter.press('Enter');

  await expect(branchFilter).toBeFocused();
  await expect(dialog).toBeVisible();
  expect(configWrites).toHaveLength(0);

  await releaseBranch.click();
  await expect(dialog.getByRole('button', { name: 'Base Branch (optional)' })).toContainText('release/2026.09');
  await dialog.getByRole('button', { name: 'Add Repository', exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect.poll(() => configWrites.length).toBe(1);
  expect(configWrites[0]).toMatchObject({
    repos_to_monitor: [{ name: 'integry/propr', baseBranch: 'release/2026.09' }],
  });
});

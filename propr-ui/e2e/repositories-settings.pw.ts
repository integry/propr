import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CurrentUser, MonitoredRepo } from '../src/api/proprApi';

const repositoryIconFixture = fileURLToPath(new URL('../public/logo.png', import.meta.url));

async function stubRepositoryApis(page: Page, canManage = true, initialRepos?: MonitoredRepo[]) {
  let repos: MonitoredRepo[] = initialRepos ?? [
    { id: 'propr', name: 'integry/propr', enabled: true, autoFollowupOnFailedCi: false, visualPreview: { enabled: true, types: ['image'] } },
    { id: 'sdk', name: 'integry/integration-sdk', enabled: true, baseBranch: 'main', visualPreview: { enabled: false, types: ['image'] } },
    { id: 'docs', name: 'integry/documentation', enabled: false, visualPreview: { enabled: true, types: ['image'] } },
  ];
  const writes: MonitoredRepo[][] = [];
  let chatLoads = 0;
  const indexingWrites: { path: string; body: unknown }[] = [];
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('https://raw.githubusercontent.com/**', route => route.fulfill({
    path: repositoryIconFixture,
    contentType: 'image/png',
  }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown;
    switch (path) {
      case '/api/auth/demo-mode': json = { demoMode: false }; break;
      case '/api/auth/user':
        json = {
          id: 'preview-user',
          login: 'preview',
          username: 'preview',
          displayName: 'Preview User',
          email: null,
          avatarUrl: null,
          role: canManage ? 'admin' : 'member',
          permissions: canManage ? ['instance.manage_settings'] : [],
          authorizationSource: 'local',
        } satisfies CurrentUser;
        break;
      case '/api/config/repos':
        if (route.request().method() === 'POST') {
          repos = route.request().postDataJSON().repos_to_monitor;
          writes.push(repos);
        }
        json = { success: true, repos_to_monitor: repos };
        break;
      case '/api/config/repos/trigger-indexing':
      case '/api/config/repos/stop-indexing':
        indexingWrites.push({ path, body: route.request().postDataJSON() });
        json = { success: true };
        break;
      case '/api/instance/catalog': json = { repositories: repos, agents: [] }; break;
      case '/api/github/repos': json = { repos: [] }; break;
      case '/api/user/repo-preferences': json = { preferences: { 'integry/propr': { starred: true } } }; break;
      case '/api/repositories/indexing-status':
        json = { repositories: repos.map((repo, index) => ({
          full_name: repo.name, branch: repo.baseBranch || 'HEAD', indexing_status: 'completed',
          last_indexed_at: new Date(Date.now() - (index + 1) * 3600000).toISOString(), last_indexed_hash: '8a6fe50123456789', last_indexed_commit_message: 'Update repository',
          icon_path: index < 2 ? 'public/logo.png' : null,
        })) };
        break;
      case '/api/repos/chat/messages': chatLoads++; json = { messages: [] }; break;
      case '/api/notifications/unread-count': json = { unreadCount: 0 }; break;
      default:
        await route.fulfill({ status: 503, json: { error: 'Optional API unavailable in repository UI test' } });
        return;
    }
    await route.fulfill({ json });
  });
  return { writes, indexingWrites, chatLoads: () => chatLoads };
}

test('shows and updates the follow-up CI cancellation option and its workflow selection', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await stubRepositoryApis(page, true, [
    {
      id: 'propr-main', name: 'integry/propr', baseBranch: 'main', enabled: true,
      cancelCiDuringFollowup: true, cancelCiDuringFollowupWorkflows: ['pr-build-check.yml'],
      visualPreview: { enabled: false, types: ['image'] }
    },
    { id: 'propr-release', name: 'integry/propr', baseBranch: 'release', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
  ]);
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select integry/propr', exact: true }).nth(1).click();
  const settings = page.getByRole('region', { name: 'Settings for integry/propr', exact: true });
  const cancelCi = settings.getByRole('checkbox', { name: 'Cancel CI during follow-up implementation for integry/propr', exact: true });
  const workflows = settings.getByRole('textbox', { name: 'Validation workflows to cancel for integry/propr', exact: true });
  await expect(cancelCi).toBeChecked();
  await expect(workflows).toHaveValue('pr-build-check.yml');
  await expect(settings.getByText(/Cancels exactly this workflow: pr-build-check\.yml\./)).toBeVisible();
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir('../.propr/previews', { recursive: true });
    await page.screenshot({ animations: 'disabled', path: '../.propr/previews/repository-cancel-ci-workflow-selection.png' });
  }

  // The selection is stored for every branch entry of the repository.
  await workflows.fill('pr-build-check.yml, .github/workflows/pr-test-on-label.yml');
  await workflows.blur();
  await expect.poll(() => api.writes.at(-1)?.map(repo => repo.cancelCiDuringFollowupWorkflows))
    .toEqual([['pr-build-check.yml', '.github/workflows/pr-test-on-label.yml'], ['pr-build-check.yml', '.github/workflows/pr-test-on-label.yml']]);

  // Clearing it hands the decision to the environment fallback, which the empty
  // state discloses instead of promising that nothing is cancelled.
  await workflows.fill('');
  await workflows.blur();
  await expect(settings.getByText(/No workflows selected for this repository, so the instance-wide/)).toBeVisible();
  await expect(settings.getByText(/nothing is cancelled when your operator left it unset/)).toBeVisible();
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await page.screenshot({ animations: 'disabled', path: '../.propr/previews/repository-cancel-ci-empty-selection.png' });
  }

  await settings.getByText('Cancel CI while follow-up implementation is in progress', { exact: true }).click();
  await expect(cancelCi).not.toBeChecked();
  await expect(workflows).toBeHidden();
  await expect.poll(() => api.writes.at(-1)?.map(repo => repo.cancelCiDuringFollowup)).toEqual([false, false]);
});

test('shows the whole repository-wide selection the worker may cancel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Two valid branch entries, each with a selection of its own: the worker cancels
  // both workflows, so the settings must name both rather than only the first.
  await stubRepositoryApis(page, true, [
    {
      id: 'propr-main', name: 'integry/propr', baseBranch: 'main', enabled: true,
      cancelCiDuringFollowup: true, cancelCiDuringFollowupWorkflows: ['pr-build-check.yml'],
      visualPreview: { enabled: false, types: ['image'] }
    },
    {
      id: 'propr-release', name: 'integry/propr', baseBranch: 'release', enabled: true,
      cancelCiDuringFollowup: true, cancelCiDuringFollowupWorkflows: ['pr-test-on-label.yml', 'PR-BUILD-CHECK.YML'],
      visualPreview: { enabled: false, types: ['image'] }
    },
  ]);
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select integry/propr', exact: true }).nth(1).click();
  const settings = page.getByRole('region', { name: 'Settings for integry/propr', exact: true });
  const workflows = settings.getByRole('textbox', { name: 'Validation workflows to cancel for integry/propr', exact: true });
  await expect(workflows).toHaveValue('pr-build-check.yml, pr-test-on-label.yml');
  await expect(settings.getByText(/Cancels exactly these 2 workflows: pr-build-check\.yml, pr-test-on-label\.yml\./)).toBeVisible();
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir('../.propr/previews', { recursive: true });
    await page.screenshot({ animations: 'disabled', path: '../.propr/previews/repository-cancel-ci-union-selection.png' });
  }
});

test('shows and updates shared settings while preserving the selected branch', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sharedPreview = { enabled: true, types: ['video'], instructions: 'Capture the repository settings.' } satisfies NonNullable<MonitoredRepo['visualPreview']>;
  const api = await stubRepositoryApis(page, true, [
    { id: 'propr-main', name: 'integry/propr', baseBranch: 'main', enabled: true, autoFollowupOnFailedCi: true, visualPreview: sharedPreview },
    { id: 'propr-release', name: 'integry/propr', baseBranch: 'release', enabled: false, autoFollowupOnFailedCi: false, visualPreview: { enabled: false, types: ['image'], instructions: 'Stale branch instructions.' } },
  ]);
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select integry/propr', exact: true }).nth(1).click();
  const settings = page.getByRole('region', { name: 'Settings for integry/propr', exact: true });
  const autoCi = settings.getByRole('checkbox', { name: 'Automatic CI follow-up for integry/propr', exact: true });
  const previews = settings.getByRole('checkbox', { name: 'Visual previews for integry/propr', exact: true });
  await expect(autoCi).toBeChecked();
  await expect(previews).toBeChecked();
  await expect(settings.getByRole('textbox')).toHaveValue(sharedPreview.instructions);
  await expect(settings.getByRole('button', { name: 'Videos', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(settings.getByRole('button', { name: 'Images', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(settings.getByText('release', { exact: true })).toBeVisible();
  await expect(settings.getByRole('checkbox', { name: 'Monitor integry/propr', exact: true })).not.toBeChecked();
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir('../.propr/previews', { recursive: true });
    await page.screenshot({ animations: 'disabled', path: '../.propr/previews/repositories-shared-branch-settings.png' });
  }

  await settings.getByText('Auto CI follow-up', { exact: true }).click();
  await expect(autoCi).not.toBeChecked();
  await expect.poll(() => api.writes.at(-1)?.map(repo => repo.autoFollowupOnFailedCi)).toEqual([false, false]);
  await settings.getByText('Visual previews', { exact: true }).click();
  await expect(previews).not.toBeChecked();
  await expect.poll(() => api.writes.at(-1)?.map(repo => repo.visualPreview)).toEqual([
    { ...sharedPreview, enabled: false }, { ...sharedPreview, enabled: false },
  ]);
  await settings.getByText('Monitor repository', { exact: true }).click();
  await expect.poll(() => api.writes.at(-1)?.map(repo => ({ id: repo.id, baseBranch: repo.baseBranch, enabled: repo.enabled }))).toEqual([
    { id: 'propr-main', baseBranch: 'main', enabled: true },
    { id: 'propr-release', baseBranch: 'release', enabled: true },
  ]);
  await settings.getByRole('button', { name: 'Reindex repository', exact: true }).click();
  await expect.poll(() => api.indexingWrites[0]).toEqual({
    path: '/api/config/repos/trigger-indexing',
    body: { repository: 'integry/propr', baseBranch: 'release', fullReindex: true },
  });
});

test('silences notifications for every branch entry of the selected repository', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await stubRepositoryApis(page, true, [
    { id: 'propr-main', name: 'integry/propr', baseBranch: 'main', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
    { id: 'propr-release', name: 'integry/propr', baseBranch: 'release', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
    { id: 'sdk', name: 'integry/integration-sdk', enabled: true, visualPreview: { enabled: false, types: ['image'] } },
  ]);
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select integry/propr', exact: true }).first().click();
  const settings = page.getByRole('region', { name: 'Settings for integry/propr', exact: true });
  const notifications = settings.getByRole('checkbox', { name: 'Notifications for integry/propr', exact: true });
  await expect(notifications).toBeChecked();
  await expect(settings.getByText('Generate Inbox and push notifications for this repository.', { exact: false })).toBeVisible();

  await settings.locator('label', { has: page.getByRole('checkbox', { name: 'Notifications for integry/propr', exact: true }) }).click();
  await expect(notifications).not.toBeChecked();
  await expect.poll(() => api.writes.at(-1)?.map(repo => [repo.id, repo.notificationsEnabled])).toEqual([
    ['propr-main', false], ['propr-release', false], ['sdk', true],
  ]);
  await expect(page.getByText('Saved', { exact: true }).filter({ visible: true })).toBeVisible();
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir('../.propr/previews', { recursive: true });
    await page.screenshot({ animations: 'disabled', path: '../.propr/previews/repository-notifications-disabled.png' });
  }

  await page.reload();
  await page.getByRole('button', { name: 'Select integry/propr', exact: true }).first().click();
  await expect(page.getByRole('checkbox', { name: 'Notifications for integry/propr', exact: true })).not.toBeChecked();
});

test('keeps navigation compact and saves settings for the selected repository', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await stubRepositoryApis(page);
  await page.goto('/repositories');
  await expect(page.getByRole('region', { name: /Settings for/ })).toHaveCount(0);
  const propr = page.getByRole('button', { name: 'Select integry/propr', exact: true });
  const sdk = page.getByRole('button', { name: 'Select integry/integration-sdk', exact: true });
  await expect(propr.locator('../..').getByTestId('repository-icon-image')).toBeVisible();
  await expect(propr.locator('../..').getByTestId('repository-icon-image')).toHaveAttribute(
    'src',
    /\/integry\/propr\/8a6fe50123456789\/public\/logo\.png$/,
  );
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir('../.propr/previews', { recursive: true });
    await page.screenshot({ animations: 'disabled', path: '../.propr/previews/repository-icons-desktop.png' });
  }
  const originalHeight = (await propr.locator('../..').boundingBox())!.height;
  expect(originalHeight).toBe((await sdk.locator('../..').boundingBox())!.height);
  await expect(propr.locator('../..').getByText('8a6fe50', { exact: true })).toBeVisible();
  await expect(propr.locator('../..').locator('time')).toHaveText('1h ago');
  await propr.click();
  const settings = page.getByRole('region', { name: 'Settings for integry/propr', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'Repository settings', exact: true })).toHaveCount(0);
  await expect(propr.locator('../..').getByRole('checkbox')).toHaveCount(0);
  await expect(propr.locator('../..').getByRole('button')).toHaveCount(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
  await expect.poll(api.chatLoads).toBeGreaterThan(0);
  const initialChatLoads = api.chatLoads();
  await settings.getByText('Auto CI follow-up', { exact: true }).click();
  await settings.getByRole('textbox').fill('Capture separate desktop and mobile views.');
  await settings.getByRole('button', { name: 'Videos', exact: true }).click();
  await expect.poll(() => api.writes.at(-1)?.[0].visualPreview).toEqual({
    enabled: true, types: ['image', 'video'], instructions: 'Capture separate desktop and mobile views.',
  });
  expect(api.writes.at(-1)?.[0].autoFollowupOnFailedCi).toBe(true);
  expect(api.writes.at(-1)?.[1].visualPreview?.enabled).toBe(false);
  expect(api.chatLoads()).toBe(initialChatLoads);
  expect((await propr.locator('../..').boundingBox())!.height).toBe(originalHeight);

  await sdk.click();
  const sdkSettings = page.getByRole('region', { name: 'Settings for integry/integration-sdk', exact: true });
  await expect(sdkSettings.getByRole('textbox')).toHaveCount(0);
  await sdkSettings.getByText('Visual previews', { exact: true }).click();
  await expect(sdkSettings.getByRole('textbox')).toHaveValue('');
  await propr.click();
  await expect(settings.getByRole('textbox')).toHaveValue('Capture separate desktop and mobile views.');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /Automatic CI follow-up/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reindex repository', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings.getByRole('textbox')).toHaveValue('Capture separate desktop and mobile views.');
  await page.mouse.move(1400, 850);
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir('../.propr/previews', { recursive: true });
    await page.screenshot({ animations: 'disabled', path: '../.propr/previews/repositories-desktop.png' });
  }
});

for (const width of [320, 390]) {
  test(`keeps repository settings usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const api = await stubRepositoryApis(page);
    await page.goto('/repositories');
    await expect(page.getByRole('button', { name: 'Select integry/propr', exact: true }).locator('..').getByTestId('repository-icon-image')).toBeVisible();
    if (width === 390 && process.env.PROPR_CAPTURE_PREVIEWS) {
      await mkdir('../.propr/previews', { recursive: true });
      await page.screenshot({ animations: 'disabled', path: '../.propr/previews/repository-icons-mobile.png' });
    }
    await page.getByRole('button', { name: 'Select integry/propr', exact: true }).click();
    const settings = page.getByRole('region', { name: 'Settings for integry/propr', exact: true });
    await expect(settings.getByRole('textbox')).toBeVisible();
    for (const name of ['Chat', 'Improve', 'Browse', 'To-Dos', 'Settings']) {
      const tab = page.getByRole('button', { name, exact: true });
      await expect(tab).toBeInViewport({ ratio: 1 });
      const bounds = (await tab.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    const tabStrip = page.getByRole('button', { name: 'Settings', exact: true }).locator('../..');
    expect(await tabStrip.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await settings.getByRole('textbox').fill('Capture the mobile navigation.');
    await settings.getByText('Auto CI follow-up', { exact: true }).click();
    await expect.poll(() => api.writes.at(-1)?.[0].autoFollowupOnFailedCi).toBe(true);
    await expect(page.getByText('Saved', { exact: true }).filter({ visible: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const box = (await settings.getByRole('textbox').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    if (width === 390 && process.env.PROPR_CAPTURE_PREVIEWS) {
      await page.screenshot({ animations: 'disabled', path: '../.propr/previews/repositories-mobile.png' });
    }
    await settings.getByRole('button', { name: 'Reindex repository', exact: true }).scrollIntoViewIfNeeded();
    await expect(settings.getByRole('button', { name: 'Reindex repository', exact: true })).toBeInViewport();
    await settings.getByRole('button', { name: 'Remove repository from ProPR', exact: true }).scrollIntoViewIfNeeded();
    await expect(settings.getByRole('button', { name: 'Remove repository from ProPR', exact: true })).toBeInViewport();
    if (width === 390 && process.env.PROPR_CAPTURE_PREVIEWS) {
      await page.screenshot({ animations: 'disabled', path: '../.propr/previews/repositories-mobile-indexing.png' });
    }
    await page.getByRole('button', { name: 'Back to repositories' }).click();
    await expect(page.getByRole('button', { name: 'Select integry/propr', exact: true })).toBeVisible();
  });
}

test('enables visual previews while adding a repository', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await stubRepositoryApis(page);
  await page.goto('/repositories');
  await page.getByRole('button', { name: '+ Add Repository' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add Repository' });
  await dialog.getByLabel('Repository *').fill('integry/new-app');
  await expect(dialog.getByRole('checkbox', { name: /Notifications/ })).toHaveCount(0);
  await dialog.getByRole('checkbox', { name: /Automatic CI follow-up/ }).check();
  await dialog.getByRole('checkbox', { name: /Visual previews/ }).check();
  await dialog.getByRole('button', { name: 'Videos' }).click();
  await dialog.getByLabel('Preview instructions (optional)').fill('Capture desktop and mobile views.');
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir('../.propr/previews', { recursive: true });
    await dialog.screenshot({ animations: 'disabled', path: '../.propr/previews/add-repository-visual-previews.png' });
  }

  await dialog.getByRole('button', { name: 'Add Repository', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => api.writes.at(-1)?.at(-1)).toMatchObject({
    name: 'integry/new-app',
    autoFollowupOnFailedCi: true,
    notificationsEnabled: true,
    visualPreview: { enabled: true, types: ['image', 'video'], instructions: 'Capture desktop and mobile views.' },
  });
});

test('keeps repository and indexing changes unavailable to read-only users', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await stubRepositoryApis(page, false);
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select integry/propr', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: /Settings for/ })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Monitor integry/propr', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Star repository', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Hide repository', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reindex repository', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Remove repository from ProPR', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: /Automatic CI follow-up|Visual previews/ })).toHaveCount(0);
  const notifications = page.getByRole('checkbox', { name: 'Notifications for integry/propr', exact: true });
  await expect(notifications).toBeDisabled();
  // Playwright treats a disabled control's label as disabled; force the click to prove it is inert.
  await page.locator('label', { has: notifications }).click({ force: true });
  await expect(notifications).toBeChecked();
  expect(api.writes).toHaveLength(0);
});


test('reindexes and stops indexing the selected repository branch from Settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await stubRepositoryApis(page);
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select integry/integration-sdk', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings for integry/integration-sdk', exact: true });
  await expect(settings.getByText('main', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Reindex repository', exact: true }).click();
  await expect.poll(() => api.indexingWrites[0]).toEqual({
    path: '/api/config/repos/trigger-indexing',
    body: { repository: 'integry/integration-sdk', baseBranch: 'main', fullReindex: true },
  });
  await expect(settings.getByRole('button', { name: 'Reindex repository', exact: true })).toBeDisabled();
  page.once('dialog', dialog => dialog.accept());
  await settings.getByRole('button', { name: 'Stop indexing', exact: true }).click();
  await expect.poll(() => api.indexingWrites[1]).toEqual({
    path: '/api/config/repos/stop-indexing',
    body: { repository: 'integry/integration-sdk', branch: 'main' },
  });
  await page.getByRole('button', { name: 'Select integry/propr', exact: true }).click();
  const proprSettings = page.getByRole('region', { name: 'Settings for integry/propr', exact: true });
  await expect(proprSettings.getByRole('button', { name: 'Reindex repository', exact: true })).toBeEnabled();
  await expect(proprSettings.getByRole('button', { name: 'Stop indexing', exact: true })).toHaveCount(0);
});

test('saves monitoring and confirms removal from Settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await stubRepositoryApis(page);
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select integry/propr', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings for integry/propr', exact: true });
  await settings.getByText('Monitor repository', { exact: true }).click();
  await expect(settings.getByRole('checkbox', { name: 'Monitor integry/propr', exact: true })).not.toBeChecked();
  await expect.poll(() => api.writes.at(-1)?.[0].enabled).toBe(false);
  expect(api.writes.at(-1)?.[1].enabled).toBe(true);
  await expect(settings.getByRole('button', { name: 'Remove repository from ProPR', exact: true })).toHaveAccessibleDescription('This only stops tracking the repository in ProPR. It will not affect the repository on GitHub.');
  await settings.getByRole('button', { name: 'Remove repository from ProPR', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'Remove repository from ProPR', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect.poll(() => api.writes.at(-1)?.map(repo => repo.name)).toEqual(['integry/integration-sdk', 'integry/documentation']);
  await expect(page.getByRole('button', { name: 'Select integry/propr', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: /Settings for/ })).toHaveCount(0);
});

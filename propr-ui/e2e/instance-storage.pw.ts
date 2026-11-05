import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function mockStorage(page: Page) {
  const instanceId = 'local-instance'; const generation = 'generation';
  const repositories = [
    { id: 'published', name: 'sample/docs', category: 'repository_caches', estimatedBytes: 48 * 1024 ** 2, protectedReasons: [] },
    { id: 'private', name: 'sample/website', category: 'repository_caches', estimatedBytes: 132 * 1024 ** 2, protectedReasons: ['private_work'] },
    { id: 'worktrees', name: 'sample/website', category: 'worktrees', estimatedBytes: null, protectedReasons: ['worktrees'] },
  ];
  const capabilities = { version: 1, instanceId, generation, features: ['repository_inventory', 'repository_cleanup', 'database_export'] };
  let executed = false;
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/cleanup/execute')) {
      executed = true; return route.fulfill({ json: { version: 1, instanceId, operationId: 'confirmation', state: 'completed', deleted: ['published'], retained: [{ id: 'private', reasons: ['private_work'] }] } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: 'preview-admin', username: 'preview-admin', login: 'preview-admin', displayName: 'Instance administrator', email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings', 'instance.manage_agents'], authorizationSource: 'local' },
      '/api/config/settings': { worker_concurrency: 2, auto_followup_score_threshold: 4, ultrafix_rating_goal: 7, ultrafix_max_cycles: 5, ultrafix_pause_seconds: 60, model_reasoning_level: '', github_user_whitelist: [] },
      '/api/config/followup-keywords': { followup_keywords: [] },
      '/api/config/followup-ignore-keywords': { followup_ignore_keywords: [] },
      '/api/config/pr-label': { pr_label: 'propr' },
      '/api/config/primary-processing-labels': { primary_processing_labels: ['AI'] },
      '/api/config/agents': { agents: [] },
      '/api/config/summarization': { enabled: false, agent_alias: '', fallback_agent_alias: '' },
      '/api/config/agent-tank': { mode: 'disabled', enabled: false },
      '/api/config/agent-tank/status': { available: false },
      '/api/config/agent-tank/detect': { detected: false },
      '/api/instance/catalog': { agents: [], repositories: [] },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/instance/storage/v1/capabilities': capabilities,
      '/api/instance/storage/v1/repositories': { version: 1, instanceId, state: 'partial', observedAt: '2026-10-12T12:00:00Z', lastUseAt: '2026-10-12T11:45:00Z', repositories },
      '/api/instance/storage/v1/cleanup/preview': { version: 1, instanceId, confirmation: 'confirmation', expiresAt: new Date(Date.now() + 300_000).toISOString(), categories: ['repository_caches'], candidates: repositories.filter(repo => repo.category === 'repository_caches'), impact: 'Eligible repository caches are refetched on next use. Private work, unpublished history and worktrees are retained.' },
      '/api/instance/storage/v1/exports': { version: 1, instanceId, generation, operationId: 'export-job', state: 'ready', expiresAt: new Date(Date.now() + 300_000).toISOString(), scope: 'customer_database', sizeBytes: 8 * 1024 ** 2, schemaVersion: 7, migration: '20261012_customer_schema', sha256: 'a'.repeat(64) },
    };
    return pathname in responses ? route.fulfill({ json: responses[pathname] }) : route.fulfill({ status: 503, json: { error: 'Unavailable in isolated UI fixture' } });
  });
  return () => executed;
}

test('native self-hosted storage inventory, export and explicit cleanup confirmation', async ({ page }) => {
  const executed = await mockStorage(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/settings?tab=integrations');
  await page.getByPlaceholder('Search settings...').fill('database export');
  const section = page.getByRole('region', { name: 'Instance data', exact: true });
  await expect(section.getByText('sample/docs', { exact: true })).toBeVisible();
  await section.getByRole('button', { name: 'Create database export' }).click();
  await expect(section.getByRole('button', { name: 'Download once' })).toBeVisible();
  await section.getByRole('button', { name: 'Preview cache cleanup' }).click();
  await expect(section.getByRole('button', { name: 'Confirm cleanup', exact: true })).toBeDisabled();
  expect(executed()).toBe(false);
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    const directory = path.resolve('../.propr/previews'); await mkdir(directory, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 1200 });
    await section.screenshot({ path: path.join(directory, 'instance-storage-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    // Phones open the linked category; search lives on the category list.
    await page.getByRole('button', { name: 'Back to Settings' }).click();
    await page.getByPlaceholder('Search settings...').fill('database export');
    await section.getByRole('button', { name: 'Preview cache cleanup' }).click();
    const confirmation = section.getByRole('region', { name: 'Confirm repository cache cleanup' });
    await confirmation.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, 'instance-storage-mobile.png') });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ previews: [
      { path: '.propr/previews/instance-storage-desktop.png', title: 'Instance data — desktop', description: 'Native Settings export metadata, repository inventory and explicit cleanup confirmation with isolated sample data.' },
      { path: '.propr/previews/instance-storage-mobile.png', title: 'Instance data — mobile', description: 'Native cleanup confirmation and protected repository data at mobile width.' },
      { path: '.propr/previews/instance-storage-195-zoom100.png', title: 'Cleanup confirmation — 195 CSS px', description: 'Wrapped deletion impact, repository candidates, checkbox and actions at a high zoom equivalent phone width.' },
      { path: '.propr/previews/instance-storage-390-zoom200.png', title: 'Cleanup confirmation — 200% CSS zoom', description: 'The confirmation remains within a 390 px phone viewport with 200% CSS zoom.' },
    ], toolSuggestions: [] }));
  }
  await section.getByRole('checkbox').check();
  await section.getByRole('button', { name: 'Confirm cleanup', exact: true }).click();
  await expect(section.getByText('Cleanup completed: 1 deleted, 1 retained.')).toBeVisible();
  expect(executed()).toBe(true);
});

for (const { width, zoom, label } of [
  { width: 195, zoom: 1, label: '195 CSS px' },
  { width: 390, zoom: 2, label: '390 px at 200% CSS zoom' },
  { width: 320, zoom: 1, label: '320 px' },
  { width: 768, zoom: 1, label: '768 px' },
]) {
  test(`instance data fits and cleanup remains accessible at ${label}`, async ({ page }) => {
    const executed = await mockStorage(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/settings?tab=integrations');
    if (zoom !== 1) await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
    if (width < 768) await page.getByRole('button', { name: 'Back to Settings' }).click();
    await page.getByPlaceholder('Search settings...').fill('database export');
    const section = page.getByRole('region', { name: 'Instance data', exact: true });
    await section.getByRole('button', { name: 'Preview cache cleanup' }).click();
    const confirmation = section.getByRole('region', { name: 'Confirm repository cache cleanup' });
    await confirmation.scrollIntoViewIfNeeded();
    // The document can fit even while a nested Settings scroller hides content.
    // Check the actual section, controls and rendered text lines, excluding the
    // inventory table which has its own accessible horizontal scroll region.
    const layout = await section.evaluate(element => {
      const viewport = window.innerWidth;
      const fits = (rect: DOMRect) => rect.left >= -1 && rect.right <= viewport + 1;
      const table = element.querySelector('table')!;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const clippedText: string[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim() || table.contains(node)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (Array.from(range.getClientRects()).some(rect => !fits(rect))) clippedText.push(node.textContent);
      }
      const fieldset = element.closest('fieldset')!;
      const scroller = element.closest('[data-settings-scroll]')!;
      return {
        sectionFits: fits(element.getBoundingClientRect()),
        controlsFit: Array.from(element.querySelectorAll('button, input, label')).every(control => fits(control.getBoundingClientRect())),
        clippedText,
        fieldsetFits: fieldset.scrollWidth <= fieldset.clientWidth + 1,
        panelFits: scroller.scrollWidth <= scroller.clientWidth + 1,
      };
    });
    expect(layout).toEqual({ sectionFits: true, controlsFit: true, clippedText: [], fieldsetFits: true, panelFits: true });

    const inventory = section.getByRole('region', { name: 'Repository storage inventory' });
    await inventory.scrollIntoViewIfNeeded();
    await inventory.focus();
    await expect(inventory).toBeFocused();
    if (width / zoom < 448 + 32) {
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => inventory.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
      await expect.poll(async () => {
        await page.keyboard.press('ArrowRight');
        return inventory.evaluate(element => element.scrollLeft + element.clientWidth >= element.scrollWidth - 1);
      }, { intervals: [100] }).toBe(true);
    }
    await confirmation.scrollIntoViewIfNeeded();
    if (process.env.PROPR_CAPTURE_PREVIEWS && width / zoom === 195) {
      const directory = path.resolve('../.propr/previews');
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, `instance-storage-${width}-zoom${zoom * 100}.png`) });
    }
    const checkbox = confirmation.getByRole('checkbox');
    await checkbox.focus();
    await page.keyboard.press('Space');
    await expect(checkbox).toBeChecked();
    await page.keyboard.press('Tab');
    const confirm = confirmation.getByRole('button', { name: 'Confirm cleanup', exact: true });
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(section.getByText('Cleanup completed: 1 deleted, 1 retained.')).toBeVisible();
    expect(executed()).toBe(true);
  });
}

test.describe('touch access at high zoom equivalent width', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 195, height: 844 } });

  test('inventory scrolls by swipe and cleanup can be confirmed by touch', async ({ page }) => {
    const executed = await mockStorage(page);
    await page.goto('/settings?tab=integrations');
    await page.getByRole('button', { name: 'Back to Settings' }).tap();
    await page.getByPlaceholder('Search settings...').fill('database export');
    const section = page.getByRole('region', { name: 'Instance data', exact: true });
    const inventory = section.getByRole('region', { name: 'Repository storage inventory' });
    await inventory.scrollIntoViewIfNeeded();
    const box = (await inventory.boundingBox())!;
    const session = await page.context().newCDPSession(page);
    const x = box.x + box.width * 0.75;
    const y = box.y + box.height / 2;
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let distance = 10; distance <= 100; distance += 10) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - distance, y }] });
      await page.waitForTimeout(20);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => inventory.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await session.detach();
    // A tap during inertial scrolling only stops the swipe on mobile Chromium.
    await expect.poll(async () => {
      const before = await inventory.evaluate(element => element.scrollLeft);
      await page.waitForTimeout(100);
      return inventory.evaluate((element, previous) => element.scrollLeft === previous, before);
    }).toBe(true);
    await section.getByRole('button', { name: 'Preview cache cleanup' }).tap();
    const confirmation = section.getByRole('region', { name: 'Confirm repository cache cleanup' });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('checkbox').tap();
    await expect(confirmation.getByRole('checkbox')).toBeChecked();
    await confirmation.getByRole('button', { name: 'Confirm cleanup', exact: true }).tap();
    await expect(section.getByText('Cleanup completed: 1 deleted, 1 retained.')).toBeVisible();
    expect(executed()).toBe(true);
  });
});

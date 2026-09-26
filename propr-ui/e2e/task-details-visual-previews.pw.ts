import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const taskId = 'task-visual-previews-2460';
const timestamp = '2026-09-22T09:00:00.000Z';
const asset = (id: string) => `https://github.com/user-attachments/assets/${id}`;
const previewMedia = [
  { type: 'image', title: 'Task queue at desktop width', description: 'The updated task queue after the change.', url: asset('queue') },
  { type: 'video', title: 'Checkout walkthrough', url: asset('walkthrough') },
  { type: 'image', title: 'Goal workspace', description: 'The goal workspace with published evidence.', url: asset('goals') },
];

async function fixture(page: Page) {
  let image: Buffer | undefined;
  let showMedia = false;
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('https://github.com/user-attachments/assets/**', route => image && !route.request().url().endsWith('walkthrough')
    ? route.fulfill({ contentType: 'image/png', body: image }) : route.abort());
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      [`/api/task/${taskId}/history`]: {
        history: [
          { state: 'PENDING', timestamp, metadata: { model: 'gpt-6-astra' } },
          { state: 'COMPLETED', timestamp, metadata: { model: 'gpt-6-astra', pr: { url: 'https://github.com/acme/web/pull/42', number: 42 } } },
        ],
        taskInfo: { title: 'Render visual previews full width', type: 'issue', number: 41, issueNumber: 41, repoOwner: 'acme', repoName: 'web', modelName: 'gpt-6-astra' },
        previewMedia: showMedia ? previewMedia : undefined,
        usageMetricRecords: [],
      },
      [`/api/task/${taskId}/live-details`]: { events: [], todos: [], currentTask: null },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(path in responses ? { json: responses[path] } : { status: 503, json: { error: 'Unavailable in visual preview fixture' } });
  });
  // Publish a real rendered application screen as the image fixture rather than invented artwork.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByTestId('task-details')).toBeVisible();
  image = await page.screenshot();
  showMedia = true;
}

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}.png` });
}

const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const width of [320, 390, 1024, 1440, 2560]) {
  test(`renders one full-width preview per row at ${width}px`, async ({ page }) => {
    await fixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks/${taskId}`);
    const section = page.getByRole('region', { name: 'Visual Previews' });
    await expect(section.getByAltText('Task queue at desktop width')).toBeVisible();
    const figures = section.locator('figure');
    await expect(figures).toHaveCount(3);
    const column = await figures.first().evaluate(figure => figure.parentElement!.getBoundingClientRect().width);
    const boxes = await figures.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON() as DOMRect));
    for (const [index, box] of boxes.entries()) {
      expect(Math.abs(box.width - column)).toBeLessThanOrEqual(1);
      if (index) expect(box.top).toBeGreaterThanOrEqual(boxes[index - 1].bottom);
    }
    await expect(section.locator('video[controls]')).toHaveCount(1);
    const imageBox = await section.getByAltText('Task queue at desktop width').boundingBox();
    expect(imageBox!.height).toBeLessThanOrEqual(900 * 0.65 + 1);
    expect(await noHorizontalOverflow(page)).toBe(true);
    if (width === 390 || width === 1440) await capture(page, `task-visual-previews-${width}`);
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`opens a screen-capped, zoomable lightbox at ${viewport.width}px`, async ({ page, context }) => {
    await fixture(page);
    await page.setViewportSize(viewport);
    await page.goto(`/tasks/${taskId}`);
    const url = page.url();
    const trigger = page.getByRole('button', { name: 'Open full-size preview: Task queue at desktop width' });
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: 'Task queue at desktop width' });
    await expect(dialog).toBeVisible();
    expect(page.url()).toBe(url);
    expect(context.pages()).toHaveLength(1);
    await expect(dialog.getByRole('button', { name: 'Close preview' })).toBeFocused();
    await expect(dialog.getByText('1 / 2')).toBeVisible();

    const image = dialog.getByAltText('Task queue at desktop width');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).complete)).toBe(true);
    const box = await image.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await capture(page, `task-visual-preview-lightbox-${viewport.width}`);

    await image.dblclick();
    await expect(image).toHaveAttribute('style', /scale\(2\.5\)/);
    await expect(dialog.getByRole('button', { name: 'Reset zoom (currently 250%)' })).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
    await capture(page, `task-visual-preview-lightbox-zoomed-${viewport.width}`);
    await image.click();
    await expect(dialog).toBeVisible();

    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('dialog', { name: 'Goal workspace' })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('2 / 2')).toBeVisible();
    await expect(page.getByRole('dialog').getByAltText('Goal workspace')).toHaveAttribute('style', /scale\(1\)/);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    const stage = page.getByTestId('preview-lightbox-stage');
    await stage.click({ position: { x: 4, y: 4 } });
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

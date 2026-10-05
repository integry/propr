import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const taskId = 'task-visual-previews-2460';
const timestamp = '2026-09-22T09:00:00.000Z';
const asset = (id: string) => `https://github.com/user-attachments/assets/${id}`;
const privateAsset = (id: string) => `/api/preview-media/pulls/acme/web/42/${id}`;
const previewMedia = [
  { type: 'image', title: 'Task queue at desktop width', description: 'Private PR evidence served through the authenticated application media path.', url: privateAsset('queue') },
  { type: 'video', title: 'Checkout walkthrough', url: asset('walkthrough') },
  { type: 'image', title: 'Goal workspace', description: 'The goal workspace with published evidence.', url: privateAsset('goals') },
];

async function fixture(page: Page) {
  let image: Buffer | undefined;
  let showMedia = false;
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('https://github.com/user-attachments/assets/**', route => image && !route.request().url().endsWith('walkthrough')
    ? route.fulfill({ contentType: 'image/png', body: image }) : route.abort());
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/preview-media/pulls/acme/web/42/')) {
      return image ? route.fulfill({ contentType: 'image/png', body: image }) : route.abort();
    }
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
  test(`frames one capture at a time in a fixed-height canvas at ${width}px`, async ({ page }) => {
    await fixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks/${taskId}`);
    const section = page.getByRole('region', { name: /Visual evidence/ });
    await expect(section.getByRole('heading', { name: 'Visual evidence (3 captures)' })).toBeVisible();
    const image = section.getByAltText('Task queue at desktop width');
    await expect(image).toBeVisible();
    const canvas = section.getByTestId('visual-evidence-canvas');
    const canvasBox = (await canvas.boundingBox())!;
    if (width >= 640) {
      // Side by side: the framed capture takes three fifths, its description the rest, 224px tall.
      expect(Math.abs(canvasBox.height - 224)).toBeLessThanOrEqual(1);
      const imageBox = (await image.boundingBox())!;
      expect(imageBox.width / canvasBox.width).toBeGreaterThan(0.55);
      expect(imageBox.width / canvasBox.width).toBeLessThan(0.62);
    } else {
      expect(canvasBox.height).toBeLessThanOrEqual(420);
    }
    await expect(section.getByText('Private PR evidence served through the authenticated application media path.')).toBeVisible();
    await expect(section.locator('img, video')).toHaveCount(1);

    const switcher = section.getByRole('group', { name: 'Captures' });
    await switcher.getByRole('button', { name: 'Capture 2' }).click();
    await expect(section.locator('video[controls]')).toHaveCount(1);
    expect(Math.abs((await canvas.boundingBox())!.height - canvasBox.height)).toBeLessThanOrEqual(1);
    await switcher.getByRole('button', { name: 'Desktop' }).click();
    await expect(image).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
    if (width === 390 || width === 1440) await capture(page, `task-visual-previews-${width}`);
  });
}

test('collapses the scrolled mobile header into one line and keeps Files Changed named', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/tasks/${taskId}`);
  const details = page.getByTestId('task-details');
  const bar = page.getByTestId('task-mobile-compact-bar');
  const alert = details.getByRole('alert').filter({ hasText: 'Couldn’t load the changed files.' });
  await expect(alert).toBeVisible();
  await expect(bar).toBeHidden();

  // Scroll until the alert sits just under where the header used to be.
  await details.evaluate((element, target) => {
    const alertTop = element.querySelector(target)!.getBoundingClientRect().top;
    element.scrollTop += alertTop - element.getBoundingClientRect().top - 90;
  }, '[role="alert"]');
  await expect(bar).toBeVisible();

  const detailsBox = (await details.boundingBox())!;
  const barBox = (await bar.boundingBox())!;
  expect(Math.abs(barBox.y - detailsBox.y)).toBeLessThanOrEqual(1);
  expect(barBox.height).toBeLessThanOrEqual(45);
  await expect(bar).toHaveText('#42:Render visual previews full width');
  const more = bar.getByRole('button', { name: 'More task actions' });
  await expect(more).toBeVisible();
  const moreBox = (await more.boundingBox())!;
  expect(moreBox.width).toBeGreaterThanOrEqual(44);
  expect(moreBox.height).toBeGreaterThanOrEqual(44);
  await expect(bar.getByRole('button', { name: 'Follow Up' })).toHaveCount(0);
  // The title block's status badge has scrolled behind the bar, not through it.
  const badge = details.getByText('Completed', { exact: true }).first();
  const badgeBox = await badge.boundingBox();
  if (badgeBox) expect(badgeBox.y + badgeBox.height).toBeLessThanOrEqual(barBox.y);

  const heading = details.getByRole('heading', { name: 'FILES CHANGED' });
  await expect(heading).toBeVisible();
  const headingBox = (await heading.boundingBox())!;
  expect(headingBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
  expect(headingBox.y + headingBox.height).toBeLessThanOrEqual((await alert.boundingBox())!.y);
  await capture(page, 'task-mobile-collapsed-header-390');

  // Scrolled further, the header stays pinned under the bar while any of its alert is still on screen.
  // The fixture is short, so pad the page to give it room to scroll.
  await details.evaluate(element => {
    element.append(Object.assign(document.createElement('div'), { style: 'height: 800px; flex: none' }));
    element.scrollTop += 40;
  });
  const pinned = (await heading.locator('..').boundingBox())!;
  const alertBox = (await alert.boundingBox())!;
  expect(Math.abs(pinned.y - (barBox.y + barBox.height))).toBeLessThanOrEqual(2);
  expect(pinned.y + pinned.height).toBeLessThan(alertBox.y + alertBox.height);

  // The overflow rises as a bottom sheet of full-width rows, not a popover over the page.
  await more.click();
  const sheet = page.getByRole('dialog', { name: 'Task actions' });
  await expect(sheet).toBeVisible();
  // It slides up from below the screen, then rests on its bottom edge.
  await expect.poll(async () => {
    const box = (await sheet.boundingBox())!;
    return Math.round(box.y + box.height);
  }).toBe(844);
  const sheetBox = (await sheet.boundingBox())!;
  expect(sheetBox.x).toBe(0);
  expect(sheetBox.width).toBe(390);
  await expect(sheet.getByRole('menuitem')).toHaveText(['Follow Up', 'Delete']);
  for (const row of await sheet.getByRole('menuitem').all()) {
    const rowBox = (await row.boundingBox())!;
    expect(rowBox.width).toBe(390);
    expect(rowBox.height).toBeGreaterThanOrEqual(48);
  }
  await capture(page, 'task-mobile-collapsed-header-menu-390');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();
  expect(await noHorizontalOverflow(page)).toBe(true);
});

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
    // Focus returns to the frame, which now shows the capture the lightbox was left on.
    const frame = page.getByRole('button', { name: 'Open full-size preview: Goal workspace' });
    await expect(frame).toBeFocused();

    await frame.click();
    const stage = page.getByTestId('preview-lightbox-stage');
    await stage.click({ position: { x: 4, y: 4 } });
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

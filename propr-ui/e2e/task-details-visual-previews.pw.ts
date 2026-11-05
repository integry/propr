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

async function fixture(page: Page, title = 'Render visual previews full width', captureSize = { width: 1440, height: 900 }) {
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
        taskInfo: { title, type: 'issue', number: 41, issueNumber: 41, repoOwner: 'acme', repoName: 'web', modelName: 'gpt-6-astra' },
        previewMedia: showMedia ? previewMedia : undefined,
        usageMetricRecords: [],
      },
      [`/api/task/${taskId}/live-details`]: { events: [], todos: [], currentTask: null },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
      // The task's PR is still open, so its follow-ups are offered.
      '/api/pull-requests/42/scores': { repository: 'acme/web', pr_number: 42, outcome: null, merged_at: null, closed_at: null, scores: [] },
    };
    return route.fulfill(path in responses ? { json: responses[path] } : { status: 503, json: { error: 'Unavailable in visual preview fixture' } });
  });
  // Publish a real rendered application screen as the image fixture rather than invented artwork.
  await page.setViewportSize(captureSize);
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
  test(`fits the imaging stage to the capture at ${width}px`, async ({ page }) => {
    await fixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks/${taskId}`);
    const section = page.getByRole('region', { name: /Visual evidence/ });
    await expect(section.getByRole('heading', { name: 'Visual evidence (3 captures)' })).toBeVisible();
    const image = section.getByAltText('Task queue at desktop width');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const stage = section.getByTestId('visual-evidence-canvas');
    const stageBox = (await stage.boundingBox())!;
    const sectionContentWidth = await section.evaluate(node => {
      const style = getComputedStyle(node);
      return node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    });
    // The image frame stays within the section and sits below the context strip.
    expect(stageBox.width).toBeLessThanOrEqual(sectionContentWidth);
    const contextBox = (await section.getByTestId('visual-evidence-context').boundingBox())!;
    expect(contextBox.y + contextBox.height).toBeLessThanOrEqual(stageBox.y + 1);
    expect(stageBox.height).toBeLessThanOrEqual(width >= 640 ? 440 : 320);
    // Fit shows the whole capture: nothing is clipped by the stage.
    const imageBox = (await image.boundingBox())!;
    expect(Math.abs(stageBox.width - imageBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(stageBox.height - imageBox.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(imageBox.width / imageBox.height - 1440 / 900)).toBeLessThan(0.01);
    expect(imageBox.x).toBeGreaterThanOrEqual(stageBox.x);
    expect(imageBox.y).toBeGreaterThanOrEqual(stageBox.y);
    expect(imageBox.x + imageBox.width).toBeLessThanOrEqual(stageBox.x + stageBox.width + 0.5);
    expect(imageBox.y + imageBox.height).toBeLessThanOrEqual(stageBox.y + stageBox.height + 0.5);
    await expect(section.getByTestId('visual-evidence-dimensions')).toHaveText(`1440×900`);
    await expect(section.getByText('Private PR evidence served through the authenticated application media path.')).toBeVisible();
    await expect(section.locator('img, video')).toHaveCount(1);
    if (width === 390 || width === 1440) await capture(page, `task-visual-previews-${width}`);

    // 100% renders the capture's own pixels and scrolls inside the stage.
    await section.getByRole('button', { name: '100%' }).click();
    await expect(stage).toHaveAttribute('data-zoom', 'actual');
    expect(Math.round((await image.boundingBox())!.width)).toBe(1440 + 2);
    expect(await stage.evaluate(node => node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight)).toBe(true);
    expect(Math.abs((await stage.boundingBox())!.height - (width >= 640 ? 440 : 320))).toBeLessThanOrEqual(1);
    if (width === 1440) await capture(page, `task-visual-previews-actual-size-${width}`);
    await section.getByRole('button', { name: 'Fit' }).click();

    const switcher = section.getByRole('group', { name: 'Captures' });
    await switcher.getByRole('button', { name: 'Checkout walkthrough' }).click();
    await expect(section.locator('video[controls]')).toHaveCount(1);
    expect(Math.abs((await stage.boundingBox())!.height - (width >= 640 ? 440 : 320))).toBeLessThanOrEqual(1);
    await switcher.getByRole('button', { name: 'Desktop' }).click();
    await expect(image).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
  });
}

for (const captureSize of [{ width: 2560, height: 600 }, { width: 390, height: 1800 }]) {
  test(`fits a ${captureSize.width}×${captureSize.height} capture in a narrow pane`, async ({ page }) => {
    await fixture(page, 'Fit visual evidence to the capture', captureSize);
    await page.setViewportSize({ width: 406, height: 900 });
    await page.goto(`/tasks/${taskId}`);
    const section = page.getByRole('region', { name: /Visual evidence/ });
    const image = section.getByAltText('Task queue at desktop width');
    await expect(section.getByTestId('visual-evidence-dimensions')).toHaveText(`${captureSize.width}×${captureSize.height}`);
    const frame = (await section.getByTestId('visual-evidence-canvas').boundingBox())!;
    const imageBox = (await image.boundingBox())!;
    expect(Math.abs(frame.width - imageBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(frame.height - imageBox.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(frame.width / frame.height - captureSize.width / captureSize.height)).toBeLessThan(0.01);
    expect(frame.height).toBeLessThanOrEqual(320);
    expect(frame.width).toBeLessThanOrEqual(372);
    expect(await noHorizontalOverflow(page)).toBe(true);

    // An opaque image fills the Fit trigger, so an inset shadow would be hidden beneath it.
    await section.getByRole('button', { name: 'Lightbox', exact: true }).focus();
    await page.keyboard.press('Tab');
    const trigger = section.getByRole('button', { name: 'Open full-size preview: Task queue at desktop width' });
    await expect(trigger).toBeFocused();
    expect(await trigger.evaluate(node => node.matches(':focus-visible'))).toBe(true);
    const shadow = await trigger.evaluate(node => getComputedStyle(node).boxShadow);
    expect(shadow).toContain('rgb(56, 189, 248) 0px 0px 0px 2px');
    expect(shadow).not.toContain('inset');
    await expect(section.getByTestId('visual-evidence-canvas')).toHaveCSS('overflow', 'visible');
    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      await mkdir('../.propr/previews', { recursive: true });
      await section.screenshot({ animations: 'disabled', path: `../.propr/previews/task-visual-previews-fit-focus-${captureSize.width}x${captureSize.height}.png` });
    }
  });
}

for (const width of [390, 1440]) {
  for (const failure of ['403', '404', 'network', 'decode'] as const) {
    test(`keeps pending and ${failure} image placeholders visible in Fit at ${width}px`, async ({ page }) => {
      await fixture(page);
      await page.setViewportSize({ width, height: 900 });
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      await page.route('**/api/preview-media/pulls/acme/web/42/queue', async route => {
        await pending;
        if (failure === 'network') return route.abort();
        if (failure === 'decode') return route.fulfill({ contentType: 'image/png', body: 'Invalid image data' });
        return route.fulfill({ status: Number(failure), body: 'Image unavailable' });
      });
      await page.goto(`/tasks/${taskId}`);
      const section = page.getByRole('region', { name: /Visual evidence/ });
      const stage = section.getByTestId('visual-evidence-canvas');
      const loading = section.getByRole('status', { name: 'Task queue at desktop width — image loading' });
      await expect(loading).toBeVisible();
      await expect(stage).toHaveAttribute('data-zoom', 'fit');
      for (const element of [stage, loading]) {
        const box = (await element.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(64);
        expect(box.width).toBeGreaterThanOrEqual(128);
      }
      if (failure === '403' && process.env.PROPR_CAPTURE_PREVIEWS) {
        await mkdir('../.propr/previews', { recursive: true });
        await section.screenshot({ animations: 'disabled', path: `../.propr/previews/task-visual-previews-loading-${width}.png` });
      }

      release();
      const unavailable = section.getByRole('img', { name: 'Task queue at desktop width — image unavailable' });
      await expect(unavailable).toBeVisible();
      for (const element of [stage, unavailable]) {
        const box = (await element.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(64);
        expect(box.width).toBeGreaterThanOrEqual(128);
      }
      expect(await noHorizontalOverflow(page)).toBe(true);
      if (failure === '403' && process.env.PROPR_CAPTURE_PREVIEWS) {
        await section.screenshot({ animations: 'disabled', path: `../.propr/previews/task-visual-previews-unavailable-${width}.png` });
      }
    });
  }
}

test('truncates a long title in the collapsed mobile header before the overflow button', async ({ page }) => {
  const longTitle = 'Render visual previews full width across every task details pane and the lightbox';
  expect(longTitle.length).toBeGreaterThanOrEqual(80);
  await fixture(page, longTitle);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/tasks/${taskId}`);
  const details = page.getByTestId('task-details');
  const bar = page.getByTestId('task-mobile-compact-bar');
  await expect(details.getByRole('alert').filter({ hasText: 'Couldn’t load the changed files.' })).toBeVisible();
  await details.evaluate(element => {
    element.append(Object.assign(document.createElement('div'), { style: 'height: 800px; flex: none' }));
    element.scrollTop = 400;
  });
  await expect(bar).toBeVisible();

  const title = bar.getByText(longTitle);
  const titleBox = (await title.boundingBox())!;
  const moreBox = (await bar.getByRole('button', { name: 'More task actions' }).boundingBox())!;
  expect(titleBox.width).toBeLessThanOrEqual(280);
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(moreBox.x);
  expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(390);
  expect(await title.evaluate(element => element.scrollWidth > element.clientWidth && getComputedStyle(element).textOverflow === 'ellipsis')).toBe(true);
  await capture(page, 'task-mobile-collapsed-long-title-390');
});

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
  // The compact overflow control reserves a 44px tap target.
  expect(moreBox.width).toBeGreaterThanOrEqual(44);
  expect(moreBox.height).toBeGreaterThanOrEqual(44);
  expect(await more.evaluate(node => parseFloat(getComputedStyle(node).borderRadius))).toBeGreaterThan(0);
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
  // Retry is a bordered button whose tap target reaches 44px.
  const retryHitHeight = await alert.getByRole('button', { name: 'Retry' }).evaluate(button => {
    const after = getComputedStyle(button, '::after');
    return button.getBoundingClientRect().height - parseFloat(after.top) - parseFloat(after.bottom);
  });
  expect(retryHitHeight).toBeGreaterThanOrEqual(44);
  await capture(page, 'task-mobile-collapsed-header-390');

  // Scrolled further, the heading and its alert move as one block: the heading never pins over the
  // alert, so the warning icon, the title and Retry are never half-hidden under it.
  // The fixture is short, so pad the page to give it room to scroll.
  const gapBefore = (await alert.boundingBox())!.y - (headingBox.y + headingBox.height);
  await details.evaluate(element => {
    element.append(Object.assign(document.createElement('div'), { style: 'height: 800px; flex: none' }));
    element.scrollTop += 40;
  });
  const movedHeading = (await heading.boundingBox())!;
  const alertBox = (await alert.boundingBox())!;
  expect(movedHeading.y).toBeLessThan(headingBox.y - 30);
  expect(Math.abs(alertBox.y - (movedHeading.y + movedHeading.height) - gapBefore)).toBeLessThanOrEqual(1);
  await expect(heading.locator('..')).toHaveCSS('position', 'static');

  const scrollBeforeSheet = await details.evaluate(node => node.scrollTop);
  // The overflow rises as a bottom sheet of full-width rows, not a popover over the page.
  await more.click();
  const sheet = page.getByRole('dialog', { name: 'Task actions' });
  await expect(sheet).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('position', 'fixed');
  await expect(details).toHaveCSS('overflow', 'hidden');
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
    expect(rowBox.width).toBe(374);
    expect(rowBox.height).toBeGreaterThanOrEqual(48);
  }
  // Cancel is its own card with a visible gap above it, so a thumb aimed at it can't land on Delete.
  const deleteBox = (await sheet.getByRole('menuitem', { name: 'Delete' }).boundingBox())!;
  const cancelBox = (await sheet.getByRole('button', { name: 'Cancel' }).boundingBox())!;
  expect(cancelBox.y - (deleteBox.y + deleteBox.height)).toBeGreaterThanOrEqual(8);
  expect(cancelBox.height).toBeGreaterThanOrEqual(48);
  // Cancel floats at least 16px above the bottom edge, clear of the home indicator.
  expect(844 - (cancelBox.y + cancelBox.height)).toBeGreaterThanOrEqual(16);
  await capture(page, 'task-mobile-collapsed-header-menu-390');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();
  await expect(details).toHaveCSS('overflow-y', 'auto');
  expect(await details.evaluate(node => node.scrollTop)).toBe(scrollBeforeSheet);
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

import { expect, test, type Page } from '@playwright/test';
import { capture, draftSaves, fixture } from './planner-studio.fixture';
import { blockWebFonts, drawsInter, INTER_URL, interStatus, serveInter } from './task-logs.fixture';

test.beforeEach(async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

// Inter swapping in between measuring the reorder handle and pressing it moves the third tab by about
// 12px, so a press at the measured point misses the 14px handle and no drag starts. The gesture therefore
// runs in one settled font: Inter, served locally and loaded before measuring, or the fallback with the
// web font blocked. The font arriving once the drag is under way is covered on its own below.
async function dragThirdTabToFirst(page: Page, duringDrag: () => Promise<void> = async () => {}) {
  const tabs = page.getByRole('navigation', { name: 'Plan steps' });
  const stepTabs = tabs.getByRole('button', { name: /^\d+\. / });
  await expect(stepTabs.first()).toHaveAccessibleName('1. Shared Contracts');
  await tabs.getByRole('listitem').nth(2).hover();
  const handle = (await tabs.getByLabel('Reorder step 3').boundingBox())!;
  const firstTab = (await tabs.getByRole('listitem').first().boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 40, handle.y + handle.height / 2, { steps: 5 });
  await duringDrag();
  await page.mouse.move(firstTab.x + 20, firstTab.y + firstTab.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(stepTabs.first()).toHaveAccessibleName('1. Agent Run Store');
  await expect(stepTabs.nth(1)).toHaveAccessibleName('2. Shared Contracts');
  await expect(page.locator('[data-task-index="0"]')).toContainText('Agent run store');
  // The new order is what the draft saves.
  await expect.poll(() => draftSaves.at(-1)).toEqual({ draftId: 'plan-short', taskTitles: [
    expect.stringMatching(/: Agent run store/), expect.stringMatching(/: Shared contracts/), expect.stringMatching(/: Database migration/),
  ] });
  expect(draftSaves).toHaveLength(1);
}

for (const webFont of ['Inter', 'blocked'] as const) {
  test(`short plans can still be reordered from the tab bar (web font ${webFont})`, async ({ page }) => {
    const inter = webFont === 'Inter' ? await serveInter(page) : null;
    if (!inter) await blockWebFonts(page);
    await page.goto('/studio/plan-short');
    await expect(page.getByRole('navigation', { name: 'Plan steps' })).toBeVisible();
    if (inter) {
      await expect.poll(() => interStatus(page), { message: 'Inter loaded' }).toEqual(['loaded']);
      expect(inter.requested).toEqual([INTER_URL]);
    } else {
      await page.evaluate(() => document.fonts.ready);
      expect(await interStatus(page)).not.toContain('loaded');
    }
    expect(await drawsInter(page), 'the tabs are drawn in Inter').toBe(!!inter);
    await dragThirdTabToFirst(page);
    if (!inter) return;
    // Let the reordered cards finish their layout animation before capturing.
    await page.waitForTimeout(600);
    await capture(page, 'review-plan-tabs-reordered');
  });
}

test('a short-plan tab drag still applies when Inter swaps in mid-drag', async ({ page }) => {
  const inter = await serveInter(page, { held: true });
  // WebKit holds the load event for a held font.
  await page.goto('/studio/plan-short', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('navigation', { name: 'Plan steps' })).toBeVisible();
  expect(await drawsInter(page), 'the fallback is drawn while Inter is held').toBe(false);
  const tabs = page.getByRole('navigation', { name: 'Plan steps' }).getByRole('listitem');
  await dragThirdTabToFirst(page, async () => {
    const fallbackWidth = (await tabs.first().boundingBox())!.width;
    inter.release();
    await expect.poll(() => interStatus(page), { message: 'Inter loaded' }).toEqual(['loaded']);
    expect(await drawsInter(page), 'Inter is drawn').toBe(true);
    // The swap re-lays out the tabs under the active drag.
    expect((await tabs.first().boundingBox())!.width).not.toBeCloseTo(fallbackWidth, 0);
  });
});

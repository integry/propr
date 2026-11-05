import { expect, test } from '@playwright/test';
import { SCROLL_ROUNDING_TOLERANCE, scrollGap, scrollMarginMiss } from './planner-outline-scroll';
import { fixture } from './planner-studio.fixture';

test.beforeEach(async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('outline scroll check rejects headings flush with, above, or materially off the scroll margin', async ({ page }) => {
  await page.goto('/studio/plan-agents');
  const pane = page.locator('[data-task-list]');
  const card = page.locator('[data-task-index="11"]');
  await expect(card).toContainText('agentScheduleSweep.ts');
  // Scroll the real pane so the heading rests at each gap, then check the measured geometry against the outline assertion.
  // Re-aim on every poll: the card's entry animation can still move it after a scroll lands.
  for (const target of [0, -12, 12, 30, 40]) {
    await expect.poll(async () => {
      await pane.evaluate((list, target) => {
        const card = list.querySelector('[data-task-index="11"]')!;
        const gap = card.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientTop;
        list.scrollTo({ top: list.scrollTop + gap - target, behavior: 'instant' });
      }, target);
      return Math.abs((await scrollGap(card)).gap - target);
    }).toBeLessThanOrEqual(SCROLL_ROUNDING_TOLERANCE);
    expect(await scrollMarginMiss(card), `heading at ${target}px`).toBeGreaterThan(SCROLL_ROUNDING_TOLERANCE);
  }
});

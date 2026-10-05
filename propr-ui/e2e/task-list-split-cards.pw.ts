import { expect, test } from '@playwright/test';
import { capture, fixture } from './task-list-desktop.fixture';

test('1920px the list beside an open task is three-line cards that scroll inside their pane', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await fixture(page);
  await page.goto('/tasks?repository=integry%2Fpropr&task=pr-2664-run-0');
  const list = page.getByTestId('task-split-list');
  const cards = list.locator('[data-testid="task-card"]');
  await expect(cards.first()).toBeVisible();
  // Chips, status and times; title; runs, agent and phase. A preview count sits on the chip line, not after the summary.
  const shapes = await cards.evaluateAll(nodes => nodes.map(card => {
    const chip = card.querySelector('[title^="Pull request"], [title^="Issue"]')!.getBoundingClientRect();
    const preview = card.querySelector('[data-testid="preview-count"]')?.getBoundingClientRect();
    return { height: card.getBoundingClientRect().height, previewOnChipLine: preview ? Math.abs(preview.top - chip.top) < 4 : null };
  }));
  for (const shape of shapes) expect(shape.height).toBeLessThanOrEqual(74);
  expect(shapes.filter(shape => shape.previewOnChipLine !== null).map(shape => shape.previewOnChipLine)).toEqual([true]);
  await expect(cards.getByTestId('preview-count')).toHaveText('2 previews');
  // At 1080px every card fits; a short window gives the list something to scroll.
  await page.setViewportSize({ width: 1920, height: 560 });
  const scroller = list.getByTestId('task-list-scroll');
  // Cards scrolled up under the toolbar fade out at the top edge instead of being sliced against its border.
  const topFade = await scroller.evaluate(node => {
    node.scrollTop = 150;
    const fade = node.querySelector('[data-testid="task-cards-top-fade"]')!;
    return { scrolled: node.scrollTop, offset: Math.round(fade.getBoundingClientRect().top - node.getBoundingClientRect().top), height: fade.getBoundingClientRect().height };
  });
  expect(topFade.scrolled).toBeGreaterThan(0);
  expect(topFade).toMatchObject({ offset: 0, height: 8 });
  // At the end the last card sits whole above the footer, with room to spare.
  await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const runOut = await page.evaluate(() => {
    const all = [...document.querySelectorAll('[data-testid="task-split-list"] [data-testid="task-card"]')];
    const footer = document.querySelector('[data-testid="task-list-footer"]')!.getBoundingClientRect();
    return Math.round(footer.top - all[all.length - 1].getBoundingClientRect().bottom);
  });
  expect(runOut).toBeGreaterThanOrEqual(32);
  await capture(page, 'tasks-split-1920-end');
});

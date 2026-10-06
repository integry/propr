import { expect, test } from '@playwright/test';
import { capture, fixture } from './task-list-desktop.fixture';

test('hovering a row underlines nothing: the whole row is the link', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await fixture(page);
  await page.goto('/tasks');
  const row = page.getByTestId('task-row').filter({ hasText: 'Stop work when an issue or PR withdraws intent' }).locator('[role="row"]');
  const title = row.locator('.task-title');
  const reference = row.getByText(/^(PR|Issue) #\d+$/).first();
  await title.hover();
  const decoration = (locator: typeof title) => locator.evaluate(node => getComputedStyle(node).textDecorationLine);
  await expect.poll(() => decoration(title)).toBe('none');
  await expect.poll(() => decoration(reference)).toBe('none');
  await reference.hover();
  await expect.poll(() => decoration(reference)).toBe('none');
  await title.hover();
  await capture(page, 'tasks-row-hover');
});

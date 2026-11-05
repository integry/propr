import { expect, test } from '@playwright/test';
import { capture, fixture } from './task-list-desktop.fixture';

for (const action of ['close', 'select'] as const) {
  test(`delayed search clear preserves task ${action}`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await fixture(page);
    await page.goto('/tasks?repository=integry%2Fpropr&task=pr-2664-run-0&search=j');
    const details = page.getByTestId('task-split-details');
    await expect(details.getByTestId('task-details')).toBeVisible();
    // Freeze the debounce deadline while changing selection. No sleeps or
    // scheduling assumptions: the search callback runs only when advanced.
    await page.clock.install({ time: new Date('2026-10-11T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-11T12:01:00Z'));
    const search = page.getByPlaceholder('Search tasks...');
    await search.fill('');
    await search.blur();
    if (action === 'close') {
      await page.keyboard.press('Escape');
      await expect(details).toHaveCount(0);
    } else {
      await page.keyboard.press('j');
      await expect(page).toHaveURL(/task=pr-2661-run-0/);
    }
    await page.clock.runFor(400);
    await expect(page).not.toHaveURL(/search=/);
    await expect(page).toHaveURL(/repository=integry%2Fpropr/);
    if (action === 'close') {
      await expect(page).not.toHaveURL(/task=/);
      await expect(details).toHaveCount(0);
      await expect(page.getByRole('table', { name: 'Tasks' })).toBeVisible();
      await capture(page, 'task-search-clear-keeps-pane-closed');
    } else {
      await expect(page).toHaveURL(/task=pr-2661-run-0/);
      await expect(details).toBeVisible();
    }
  });
}

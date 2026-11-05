import { expect, test } from '@playwright/test';
import { capture, fixture, selectedRun } from './task-list-desktop.fixture';

for (const width of [390, 880, 1390, 1920]) {
  test(`diff dialog stays above task headers and remains usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page, 'linux');
    await page.goto(`/tasks/${selectedRun}`);
    const file = page.getByText('withdrawalLabels.ts', { exact: true }).first();
    await file.click();
    const close = page.getByRole('button', { name: 'Close diff view' });
    await expect(close).toBeVisible();
    expect(await close.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
    const dialog = page.getByRole('dialog', { name: 'withdrawalLabels.ts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('src/jobs/withdrawalLabels.ts', { exact: true })).toBeVisible();
    await expect(dialog).toContainText('isIntentLabel(label)');
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.locator('[tabindex="0"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await capture(page, `diff-dialog-${width}`);
    await page.setViewportSize({ width: 880, height: 620 });
    await expect(close).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await file.click();
    await close.click();
    await expect(dialog).toHaveCount(0);
    await file.click();
    // The desktop titlebar belongs to the window: a click there does not dismiss the dialog; the backdrop below does.
    await page.mouse.click(2, 2);
    await expect(dialog).toBeVisible();
    await page.mouse.click(2, 300);
    await expect(dialog).toHaveCount(0);
    expect(await page.locator('#root').evaluate(element => (element as HTMLElement).inert)).toBe(false);
  });
}

test('split task pane diff escapes its container and sticky headers', async ({ page }) => {
  await page.setViewportSize({ width: 1390, height: 900 });
  await fixture(page, 'linux');
  await page.goto('/tasks');
  await page.getByRole('link', { name: 'Stop work when an issue or PR withdraws intent' }).click();
  await page.getByText('withdrawalLabels.ts', { exact: true }).first().click();
  const close = page.getByRole('button', { name: 'Close diff view' });
  await close.click();
  await expect(close).toHaveCount(0);
});

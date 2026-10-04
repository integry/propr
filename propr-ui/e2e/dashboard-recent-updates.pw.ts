import { expect, test } from '@playwright/test';
import { captureTarget, fixture, minutesAgo, outcomes, respond } from './dashboard-sections.fixture';

for (const width of [1440, 390]) {
  test(`recent updates retain reviews and multiline recap content at ${width}px`, async ({ page }) => {
    await fixture(page, { width, height: 1000 }, [], []);
    const earlierUpdates = [
      { ...outcomes[0], id: 'review', taskId: 'review', taskType: 'review', title: 'Followup: Dashboard cleanup',
        detail: '2 issues found: Missing reviews; Clipped descriptions', score: 6, occurredAt: minutesAgo(16) },
      { ...outcomes[1], id: 'fix', taskId: 'fix', taskType: 'fix', title: 'Review PR #2467: Dashboard cleanup',
        detail: 'Implemented fixes:\n · Preserve reviews\n · Keep all recap lines visible', score: null, occurredAt: minutesAgo(30) },
      { ...outcomes[0], id: 'review-no-score', taskId: 'review-no-score', taskType: 'review', title: 'Followup: Dashboard cleanup',
        detail: '1 reviewer failed', score: null, occurredAt: minutesAgo(40) },
    ];
    await respond(page, 'dashboard/outcomes', { limit: 50, items: [{ ...outcomes[1],
      title: 'Followup: Dashboard cleanup', detail: 'Preserved review history and complete update descriptions.',
      eventCount: 4, earlierUpdates }] });
    await page.goto('/');
    const section = page.getByTestId('completed-section');
    await section.getByRole('button', { name: '3 earlier updates' }).click();
    const updates = section.locator('li ul');
    await expect(updates.getByTestId('work-type-badge')).toHaveText(['Review', 'Fix', 'Review']);
    await expect(updates.getByText('Review score 6 out of 10')).toHaveCount(1);
    const recap = updates.getByText('Implemented fixes: · Preserve reviews · Keep all recap lines visible', { exact: true });
    await expect(recap).toBeVisible();
    await expect(recap).toHaveAttribute('title', earlierUpdates[1].detail!);
    expect(await recap.evaluate(node => node.textContent?.includes('\n'))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await captureTarget(section, `recent-updates-${width}`);
  });
}

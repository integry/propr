import { expect, test } from '@playwright/test';
import { capture, fixRun, fixture } from './task-list-desktop.fixture';

test('390px the full-page timeline wraps each run\'s result, time and duration under a readable summary', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // An open fix shows its commit, the widest result a run has.
  await page.goto(`/tasks/${fixRun}`);
  const timeline = page.getByRole('list', { name: 'Runs' });
  const runRows = timeline.getByTestId('run-timeline-run');
  await expect(runRows).toHaveCount(8);
  const open = runRows.nth(1).getByRole('button');
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  await expect(open.getByTestId('run-commit')).toBeVisible();
  await expect(open.getByTestId('run-commit')).toHaveText('a81d3f5');
  for (const row of await runRows.all()) {
    const layout = await row.getByRole('button').evaluate(button => {
      const box = button.getBoundingClientRect();
      const summary = button.querySelector('[title].truncate')!.getBoundingClientRect();
      const meta = button.querySelector('[data-testid="run-timeline-meta"]')!.getBoundingClientRect();
      return { overflows: button.scrollWidth > button.clientWidth, right: box.right, summary: summary.width, summaryBottom: summary.bottom, meta };
    });
    expect(layout.overflows).toBe(false);
    // The summary keeps the row; what followed it moves to a second line, still ending on the row's right edge.
    expect(layout.summary).toBeGreaterThan(120);
    expect(layout.meta.top).toBeGreaterThanOrEqual(layout.summaryBottom - 1);
    expect(layout.meta.right).toBeLessThanOrEqual(layout.right);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(timeline).toContainText('Fixed seedCommit test');
  await capture(page, 'task-timeline-fix-390');
});

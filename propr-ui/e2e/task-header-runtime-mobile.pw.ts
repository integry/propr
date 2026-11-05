import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture, historicalRun, historicalHistory, tasks } from './task-list-desktop.fixture';

for (const width of [360, 380, 390]) {
  for (const model of ['gpt-6-astra', 'claude-opus-5-5-extended-thinking-high-reasoning-preview']) {
    test(`${width}px: ${model} keeps the runtime and actions inside the header gutter`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await fixture(page);
      await page.route(url => url.pathname === '/api/tasks', route => route.fulfill({ json: {
        tasks: [{ ...tasks.find(task => task.id === historicalRun)!, model }], total: 1, totalRuns: 1,
      } }));
      await page.route(`**/api/task/${historicalRun}/history`, route => route.fulfill({ json: {
        history: historicalHistory.map(item => ({ ...item, metadata: { ...item.metadata, model } })),
        taskInfo: {
          title: 'Keep the task header readable on phones', type: 'pr', number: 2664,
          repoOwner: 'integry', repoName: 'propr', modelName: model,
        },
      } }));
      await page.goto(`/tasks/${historicalRun}`);
      const metadata = page.getByTestId('task-mobile-metadata');
      const runtime = metadata.getByRole('group', { name: 'Execution runtime' });
      const chip = runtime.locator(':scope > span').first();
      const duration = runtime.locator(':scope > span').last();
      const more = metadata.getByRole('button', { name: 'More task actions' });
      await expect(duration).toHaveText('3m 0s');
      for (const control of [chip, duration, more]) {
        await expect(control).toBeVisible();
        const box = (await control.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(12);
        expect(box.x + box.width).toBeLessThanOrEqual(width - 12);
      }
      // Long display names keep their width and move the runtime below the chip.
      if (model.includes('extended')) {
        const chipBox = (await chip.boundingBox())!;
        expect((await duration.boundingBox())!.y).toBeGreaterThanOrEqual(chipBox.y + chipBox.height);
      }
      expect(await metadata.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await more.click();
      await expect(page.getByRole('dialog', { name: 'Task actions' })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      if (process.env.PROPR_CAPTURE_PREVIEWS && width === 380 && model.includes('extended')) {
        const directory = path.resolve('../.propr/previews');
        await mkdir(directory, { recursive: true });
        const detailsBox = (await page.getByTestId('task-details').boundingBox())!;
        const metadataBox = (await metadata.boundingBox())!;
        await page.screenshot({
          path: path.join(directory, 'task-header-runtime-380.png'), animations: 'disabled',
          clip: { x: 0, y: detailsBox.y, width, height: metadataBox.y + metadataBox.height - detailsBox.y + 6 },
        });
      }
    });
  }
}

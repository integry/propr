import { test } from '@playwright/test';
import { shot } from '../lib/shot';
import { installWorld } from '../lib/world';
import { NOW, base } from '../world/base';
import { dashboard, todos } from '../world/dashboard';
import { catalog } from '../world/settings';

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: NOW });
});

test('dashboard needs attention', async ({ page }, info) => {
  const log = await installWorld(page, base, catalog, dashboard);
  await page.goto('/');
  // The panel stretches to the running column's height; stop the crop under its last row.
  const panel = page.getByTestId('needs-attention-panel');
  const list = panel.getByRole('list');
  await list.waitFor();
  const [top, rows] = [await panel.boundingBox(), await list.boundingBox()];
  await shot(page, panel, {
    id: 'dashboard-needs-attention',
    alt: 'Needs attention: a goal asking a question, a plan pull request waiting for review, and a fix run that failed, each with its next action',
    usedOn: ['/control/'],
    padding: 0,
    maxHeight: rows!.y + rows!.height - top!.y,
  }, info, log);
});

test('dashboard running work', async ({ page }, info) => {
  const log = await installWorld(page, base, catalog, dashboard);
  await page.goto('/');
  await shot(page, page.getByTestId('happening-now-section'), {
    id: 'dashboard-running',
    alt: 'Happening now: five agents at work across Northwind repositories, each row showing what the agent is doing, its step and elapsed time, with one more task queued',
    usedOn: ['/control/', '/'],
    padding: 0,
  }, info, log);
});

test('dashboard completed feed', async ({ page }, info) => {
  const log = await installWorld(page, base, catalog, dashboard);
  await page.goto('/');
  await shot(page, page.getByTestId('completed-section'), {
    id: 'dashboard-completed',
    alt: 'Completed work: reviews with their scores and findings, applied fixes, and newly opened pull requests',
    usedOn: ['/control/'],
    padding: 0,
    maxHeight: 400,
  }, info, log);
});

test('quick add to-do', async ({ page }, info) => {
  const log = await installWorld(page, base, catalog, dashboard, todos);
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Quick add to-do' }).filter({ visible: true });
  await trigger.click();
  // The popover is the trigger's sibling and has no role of its own.
  const panel = trigger.locator('..').locator(':scope > div');
  await panel.getByRole('button', { name: 'northwind/storefront-web' }).click();
  await panel.getByRole('button', { name: 'northwind/courier-app' }).click();
  await panel.getByRole('textbox').fill('Courier app: show the customer\'s door code on the delivery screen\nOnly while the courier is within 200 m of the address.');
  await panel.getByRole('button', { name: 'Uncategorized' }).click();
  await panel.getByRole('button', { name: 'Ideas' }).click();
  await page.mouse.move(0, 0);
  await shot(page, panel, {
    id: 'dashboard-quick-add-todo',
    alt: 'Quick add to-do from the toolbar: pick a repository and category, jot the idea, and save it for later',
    usedOn: ['/planning/'],
    padding: 0,
  }, info, log);
});

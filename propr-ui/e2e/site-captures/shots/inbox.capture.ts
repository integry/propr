import { expect, test } from '@playwright/test';
import { shot } from '../lib/shot';
import { installWorld } from '../lib/world';
import { NOW, base } from '../world/base';
import { inbox } from '../world/inbox';
import { catalog } from '../world/settings';

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: NOW });
});

test('inbox list', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const log = await installWorld(page, base, catalog, inbox);
  await page.goto('/inbox');
  const rows = page.getByRole('article');
  await expect(rows).toHaveCount(6);
  await shot(page, rows.first(), {
    id: 'inbox-list',
    alt: 'The Inbox: review results with scores and findings, a finished fix, and a plan ready to approve, newest first',
    usedOn: ['/whats-new/0.9.0/', '/mobile/'],
    include: [rows.nth(3)],
    padding: 0,
  }, info, log);
});

test('inbox on a phone', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const log = await installWorld(page, base, catalog, inbox);
  await page.goto('/inbox');
  await expect(page.getByRole('article')).toHaveCount(6);
  await shot(page, page.locator('body'), {
    id: 'inbox-mobile',
    alt: 'The Inbox on a phone: reviews, fixes and a plan, each with its next action',
    usedOn: ['/mobile/', '/whats-new/0.9.0/'],
    padding: 0,
  }, info, log);
});

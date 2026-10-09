import { expect, test } from '@playwright/test';
import { shot } from '../lib/shot';
import { installWorld } from '../lib/world';
import { NOW, base } from '../world/base';
import { dashboard, search } from '../world/dashboard';
import { catalog } from '../world/settings';

test('search palette', async ({ page }, info) => {
  await page.clock.install({ time: NOW });
  const log = await installWorld(page, base, catalog, dashboard, search);
  await page.goto('/');
  const input = page.getByRole('combobox', { name: 'Search' });
  await input.fill('refund');
  const palette = page.getByTestId('global-search-palette');
  await expect(palette.getByRole('option').first()).toBeVisible();
  await expect(palette.getByTestId('global-search-preview').getByRole('heading')).toBeVisible();
  await shot(page, palette, {
    id: 'search-palette',
    alt: 'The Cmd/Ctrl+K palette searching "refund": matching plans and tasks on the left, a live preview of the selected plan on the right',
    usedOn: ['/whats-new/0.9.0/', '/control/'],
    include: [input],
    padding: 0,
  }, info, log);
});

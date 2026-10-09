import { expect, test } from '@playwright/test';
import { shot } from '../lib/shot';
import { installWorld } from '../lib/world';
import { NOW, base } from '../world/base';
import { mcp } from '../world/mcp';
import { catalog } from '../world/settings';

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: NOW });
});

test('mcp server settings', async ({ page }, info) => {
  const log = await installWorld(page, base, catalog, mcp);
  await page.goto('/settings?tab=integrations');
  const section = page.getByRole('region', { name: /MCP/ });
  await expect(section.getByText('Connection URL')).toBeVisible();
  await shot(page, section, {
    id: 'mcp-server-settings',
    alt: 'MCP server settings: enabled, the connection URL to paste into a chat client, the scopes an admin allows, and a link to connected apps',
    usedOn: ['/whats-new/0.9.0/', '/control/'],
    maxWidth: 712,
  }, info, log);
});

test('mcp access log', async ({ page }, info) => {
  const log = await installWorld(page, base, catalog, mcp);
  await page.goto('/mcp-logs');
  const table = page.getByRole('table');
  await expect(table.getByText('create_plan')).toBeVisible();
  await shot(page, table, {
    id: 'mcp-access-log',
    alt: 'The MCP Log: each tool call with its client, repository, outcome and duration; one call to a repository outside the grant is denied',
    usedOn: ['/whats-new/0.9.0/', '/trust/'],
    padding: 0,
  }, info, log);
});

import { expect, test } from '@playwright/test';
import { shot } from '../lib/shot';
import { installWorld } from '../lib/world';
import { NOW, base } from '../world/base';
import { dashboard } from '../world/dashboard';
import { catalog } from '../world/settings';
import { agentTankUsage } from '../world/usage';

test('agent tank usage in the sidebar', async ({ page }, info) => {
  await page.clock.install({ time: NOW });
  // Open the providers' rows, as someone watching their quotas leaves them.
  await page.addInitScript(() => localStorage.setItem('agent-tank-expanded-agents', JSON.stringify(['claude', 'codex', 'antigravity'])));
  await page.setViewportSize({ width: 1440, height: 1100 });
  const log = await installWorld(page, base, catalog, dashboard, agentTankUsage);
  await page.goto('/');
  const sidebar = page.getByRole('complementary');
  const heading = sidebar.getByText('Usage', { exact: true });
  await expect(heading).toBeVisible();
  const widget = heading.locator('xpath=../..');
  await shot(page, widget, {
    id: 'usage-agent-tank-sidebar',
    alt: 'Agent Tank in the sidebar: Claude session and weekly windows, Codex five-hour and weekly windows, and Antigravity per-model quotas, each as a usage bar',
    usedOn: ['/cost/', '/agents/'],
    padding: 0,
  }, info, log);
});

import { test } from '@playwright/test';
import { shot } from '../lib/shot';
import { installWorld } from '../lib/world';
import { base } from '../world/base';
import { agentTank } from '../world/settings';

test('agent tank modes', async ({ page }, info) => {
  const log = await installWorld(page, base, agentTank('bundled'));
  await page.goto('/settings?tab=integrations');
  await shot(page, page.getByRole('region', { name: 'LLM Usage Tracking' }), {
    id: 'settings-agent-tank-modes',
    alt: 'Agent Tank setting with Disabled, Bundled and External modes; Bundled is selected and ready',
    usedOn: ['/agent-tank/'],
  }, info, log);
});

import { expect, test } from '@playwright/test';
import { shot } from '../lib/shot';
import { installWorld } from '../lib/world';
import { NOW, base } from '../world/base';
import { agentTank, catalog, codingAgents, notificationPreferences, phaseModels } from '../world/settings';

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: NOW });
});

test('agent tank modes', async ({ page }, info) => {
  const log = await installWorld(page, base, catalog, agentTank('bundled'));
  await page.goto('/settings?tab=integrations');
  await shot(page, page.getByRole('region', { name: 'LLM Usage Tracking' }), {
    id: 'settings-agent-tank-modes',
    alt: 'Agent Tank setting with Disabled, Bundled and External modes; Bundled is selected and ready',
    usedOn: ['/cost/'],
  }, info, log);
});

test('notification routing', async ({ page }, info) => {
  const log = await installWorld(page, base, catalog, notificationPreferences);
  await page.goto('/settings?tab=notifications');
  const routing = page.getByRole('region', { name: 'Personal notifications' });
  await expect(routing.getByRole('checkbox', { name: 'Push notifications for Reviews' })).toBeChecked();
  await shot(page, routing, {
    id: 'settings-notification-routing',
    alt: 'Personal notifications: Inbox and Push switched per category, with Indexing turned off and push on for plans, reviews, pull requests and system failures',
    usedOn: ['/whats-new/0.9.0/', '/mobile/'],
    maxWidth: 712,
  }, info, log);
});

test('quiet hours', async ({ page }, info) => {
  const log = await installWorld(page, base, catalog, notificationPreferences);
  await page.goto('/settings?tab=notifications');
  const quiet = page.getByRole('region', { name: 'Quiet hours' });
  await expect(quiet.getByLabel('Start')).toHaveValue('22:00');
  await shot(page, quiet, {
    id: 'settings-quiet-hours',
    alt: 'Quiet hours from 22:00 to 07:00, Europe/Lisbon: push waits until morning while the Inbox updates immediately',
    usedOn: ['/mobile/'],
    maxWidth: 712,
  }, info, log);
});

test('phase models', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1800 });
  const log = await installWorld(page, base, codingAgents, phaseModels);
  await page.goto('/settings');
  await shot(page, page.getByRole('region', { name: 'Implementation' }), {
    id: 'settings-phase-models',
    alt: 'Models per phase: Claude implements at high reasoning, Claude Sonnet 5.5 analyses plan context and Claude Opus 5.5 writes the plan',
    usedOn: ['/agents/', '/planning/'],
    include: [page.getByText('Used for generating detailed implementation plans from context.')],
    maxWidth: 712,
    padding: 16,
  }, info, log);
});

test('review model and context budget', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1800 });
  const log = await installWorld(page, base, codingAgents, phaseModels);
  await page.goto('/settings');
  const review = page.getByRole('region', { name: 'Review' });
  await shot(page, review, {
    id: 'settings-review-model',
    alt: 'Review settings: GPT-6.1 Sol reviews pull requests, a Claude Sonnet 5.5 scout gathers related unchanged code, and the review uses its full context budget',
    usedOn: ['/review/'],
    include: [review.getByRole('slider')],
    maxWidth: 712,
    maxHeight: await (async () => {
      const [top, slider] = [await review.boundingBox(), await review.getByRole('slider').boundingBox()];
      return slider!.y + slider!.height + 52 - top!.y;
    })(),
  }, info, log);
});

test('coding agents', async ({ page }, info) => {
  await page.setViewportSize({ width: 1920, height: 1100 });
  const log = await installWorld(page, base, codingAgents);
  await page.goto('/ai-agents');
  const configuration = page.getByTestId('ai-agents-configuration-pane');
  await expect(configuration.getByText('Ready', { exact: true }).first()).toBeVisible();
  await configuration.getByRole('button', { name: 'Collapse codex models' }).click();
  await page.mouse.move(0, 0);
  // The pane fills the window; stop the crop under the last agent.
  const [top, last] = [await configuration.boundingBox(), await configuration.getByRole('button', { name: 'More actions for opencode' }).boundingBox()];
  await shot(page, configuration, {
    id: 'settings-coding-agents',
    alt: 'Coding agents: Claude Code, Codex, Mistral Vibe, Antigravity and OpenCode, each with its health and default model',
    usedOn: ['/agents/'],
    padding: 0,
    maxHeight: last!.y + last!.height + 24 - top!.y,
  }, info, log);
});

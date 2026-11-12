import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { installSettingsFixture } from './settings-layout.fixture';

test('implementation escalation is off by default and saves its triggers, models and maximum', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await installSettingsFixture(page);
  await page.goto('/settings?tab=ultrafix');
  const section = page.getByRole('region', { name: 'Implementation Escalation', exact: true });
  await expect(section.getByLabel('Escalate Failed Attempts')).not.toBeChecked();
  await expect(section.getByLabel('Follow Up on Failed Validation')).not.toBeChecked();
  await expect(section.getByLabel('Max Reasoning Levels per Model')).toHaveCount(0);
  const preview = async (name: string) => {
    if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
    await mkdir(path.resolve('../.propr/previews'), { recursive: true });
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: path.resolve(`../.propr/previews/${name}.png`), animations: 'disabled' });
  };
  await preview('implementation-escalation-off');

  await section.getByLabel('Escalate Failed Attempts').check();
  await section.getByLabel('Follow Up on Failed Validation').check();
  await section.getByLabel('Add implementation escalation model').selectOption('claude:claude-opus-5-5');
  await expect(section.getByLabel('Implementation escalation model 1', { exact: true })).toHaveValue('claude:claude-opus-5-5');
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config/settings'
    && response.request().method() === 'POST'
    && response.request().postDataJSON().settings.implementation_escalation_max_reasoning_levels === 1);
  await section.getByLabel('Max Reasoning Levels per Model').fill('1');
  await section.getByLabel('Max Reasoning Levels per Model').blur();
  expect((await saved).request().postDataJSON().settings).toMatchObject({
    implementation_escalation_enabled: true,
    implementation_escalation_validation_followup: true,
    implementation_escalation_models: ['claude:claude-opus-5-5'],
    implementation_escalation_max_reasoning_levels: 1,
  });
  // The Ultrafix escalation settings are a separate group.
  await expect(page.getByRole('region', { name: 'Ultrafix', exact: true }).getByLabel('Automatic Escalation')).not.toBeChecked();
  await preview('implementation-escalation-on');
  await page.setViewportSize({ width: 390, height: 1000 });
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth)).toBeLessThanOrEqual(1);
  await preview('implementation-escalation-on-390');

  await page.reload();
  await expect(section.getByLabel('Escalate Failed Attempts')).toBeChecked();
  await expect(section.getByLabel('Implementation escalation model 1', { exact: true })).toHaveValue('claude:claude-opus-5-5');
  await expect(section.getByLabel('Max Reasoning Levels per Model')).toHaveValue('1');
});

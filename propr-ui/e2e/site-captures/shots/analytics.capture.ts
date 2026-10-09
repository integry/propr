import { test, type Page } from '@playwright/test';
import { shot } from '../lib/shot';
import { installWorld } from '../lib/world';
import { analytics } from '../world/analytics';
import { base } from '../world/base';

async function open(page: Page) {
  const log = await installWorld(page, base, analytics);
  await page.goto('/analytics');
  await page.getByRole('region', { name: 'Agent efficacy by model' }).waitFor();
  return log;
}

test('analytics delivery band', async ({ page }, info) => {
  await page.setViewportSize({ width: 1040, height: 900 });
  const log = await open(page);
  // The band is the nearest container holding both its first and last metric.
  const band = page.getByTestId('metric-runs-per-task').locator('xpath=ancestor::*[.//*[@data-testid="metric-autonomy"]][1]');
  await shot(page, band, {
    id: 'analytics-delivery',
    alt: 'Analytics delivery metrics: 2.1 runs per task, 64% first-time pass, 3h 16m mean time to merge, 88% autonomy',
    usedOn: ['/control/', '/whats-new/0.9.0/'],
    padding: 0,
  }, info, log);
});

test('analytics agent efficacy', async ({ page }, info) => {
  const log = await open(page);
  await shot(page, page.getByRole('region', { name: 'Agent efficacy by model' }), {
    id: 'analytics-efficacy',
    alt: 'Agent efficacy by model: evaluated PRs, initial and final review score, score delta, runs to merge and merge rate for Claude Opus 5.5, GPT-6 Astra and Antigravity Gemini 3.1 Pro',
    usedOn: ['/control/', '/review/', '/whats-new/0.9.0/'],
    padding: 0,
  }, info, log);
});

test('analytics prompt cache', async ({ page }, info) => {
  const log = await open(page);
  const row = (label: string) => page.getByText(label, { exact: true }).locator('xpath=ancestor::*[.//dd][1]');
  await shot(page, row('Cache hit rate'), {
    id: 'analytics-cache',
    alt: 'Token consumption: 85.7% cache hit rate and the amount saved by prompt caching',
    usedOn: ['/cost/', '/whats-new/0.9.0/'],
    include: [row('Saved by caching')],
    padding: 0,
  }, info, log);
});

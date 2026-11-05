import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture, tasks, selectedRun } from './task-list-desktop.fixture';

test('follow-up cards and details agree on Codex while unresolved routing stays unknown', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page);
  // Historical execution-backed model with no queued agent alias, plus a pending follow-up.
  const runs = tasks.filter(task => task.id === selectedRun || task.id === 'pr-2656-run-0').map(task =>
    task.id === selectedRun ? { ...task, llmProvider: null } : { ...task, model: null, llmProvider: null });
  await page.route('**/api/tasks?*', route => route.fulfill({ json: { tasks: runs, total: 2, totalRuns: 2 } }));
  await page.goto('/tasks?repository=integry%2Fpropr');
  await expect(page.getByText('Unknown Model', { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByText('GPT-6 Astra', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  const directory = path.resolve(process.cwd(), '../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, 'model-identity-ledger.png'), animations: 'disabled' });
  await page.goto(`/tasks?repository=integry%2Fpropr&task=${selectedRun}`);
  const list = page.getByTestId('task-split-list');
  await expect(list.getByText('Unknown Model', { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(list.getByText('GPT-6 Astra', { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByText('GPT-6 Astra', { exact: true }).filter({ visible: true })).toHaveCount(2);
  await page.screenshot({ path: path.join(directory, 'model-identity-split.png'), animations: 'disabled' });
});

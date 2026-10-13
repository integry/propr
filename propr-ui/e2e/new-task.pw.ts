import { test, expect } from '@playwright/test';
import { fixture, screenshot, taskId, title } from './new-task.fixture';

for (const [device, viewport] of Object.entries({ desktop: { width: 1440, height: 960 }, mobile: { width: 390, height: 844 } })) {
  test(`launches an ordinary issue task on ${device}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const requests = await fixture(page);
    await page.goto('/tasks');
    await page.getByRole('button', { name: 'New Task', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New task', exact: true })).toBeVisible();
    await page.getByText('Select a repository', { exact: true }).click();
    await page.getByRole('button', { name: /acme.*billing/ }).click();
    await page.getByLabel('Prompt', { exact: true }).fill('Fix the invoice date format. Use the account locale on the invoice page and PDF export.');
    await expect(page.getByRole('button', { name: 'Run task', exact: true })).toBeEnabled();
    const dialog = page.getByRole('dialog', { name: 'New task' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Agent', { exact: true })).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Plan first', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Plan first', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('link', { name: /New Plan|New Goal/ })).toHaveCount(0);
    await screenshot(page, `new-task-${device}`);
    await page.getByRole('button', { name: 'Run task', exact: true }).click();
    await expect(page.getByRole('link', { name: 'View issue #42' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
    await expect(page.getByTestId('task-details')).toBeVisible();
    await expect(page.getByText(title, { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText("What's done?", { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Pause goal|Continue goal|Send correction/ })).toHaveCount(0);
    expect(requests.filter(request => request === 'POST /api/task-submissions')).toHaveLength(1);
    expect(requests.some(request => request.startsWith('POST /api/goals'))).toBe(false);
    expect(requests.some(request => request.startsWith('POST /api/planner'))).toBe(false);

  });
}


test('the next task preselects the last used repository, agent, and model', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await fixture(page);
  await page.goto('/tasks/new');
  await page.getByText('Select a repository', { exact: true }).click();
  await page.getByRole('button', { name: /acme.*billing/ }).click();
  await page.getByLabel('Prompt', { exact: true }).fill(title);
  await page.locator('summary', { hasText: 'Advanced Options' }).click();
  await page.getByLabel('Agent', { exact: true }).selectOption('codex');
  await page.getByLabel('Model', { exact: true }).selectOption('gpt-6-astra');
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
  await page.goto('/tasks/new');
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog.getByText('billing', { exact: true })).toBeVisible();
  await expect(dialog.getByText('codex · gpt-6-astra', { exact: true })).toBeVisible();
  await page.getByLabel('Prompt', { exact: true }).fill('Show invoice totals in the account currency');
  await expect(page.getByRole('button', { name: 'Run task', exact: true })).toBeEnabled();
  await screenshot(page, 'new-task-remembered-settings-desktop');
});

test('repository and todo launchers prefill the request without completing the todo', async ({ page }) => {
  const requests = await fixture(page);
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select acme/billing', exact: true }).first().click();
  await page.getByRole('link', { name: 'New task', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/new$/);
  await expect(page.getByRole('dialog').getByText('billing', { exact: true })).toBeVisible();
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Select acme/billing', exact: true }).first().click();
  await page.getByRole('button', { name: 'To-Dos', exact: true }).click();
  await page.getByRole('button', { name: `Select todo: ${title}` }).click();
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(title);
  await expect(page.getByRole('dialog').getByText('billing', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run task', exact: true })).toBeEnabled();
  expect(requests.filter(request => /^(POST|PATCH|PUT|DELETE) \/api\/repos\/todos/.test(request))).toEqual([]);
});


test('task modal traps focus and dismisses back to the task list', async ({ page }) => {
  await fixture(page);
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'New Task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog.getByLabel('Prompt', { exact: true })).toBeFocused();
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  const close = dialog.getByRole('button', { name: 'Close task creation' });
  await cancel.focus();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole('button', { name: 'New Task', exact: true })).toBeEnabled();
});

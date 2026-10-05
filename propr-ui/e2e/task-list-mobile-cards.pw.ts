import { expect, test } from '@playwright/test';
import { capture, fixture } from './task-list-desktop.fixture';

test('390px the header stacks its filters and card lines never cut a word to a letter or two', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tasks');
  const cards = page.locator('[data-testid="task-card"]');
  await expect(cards.first()).toBeVisible();

  // Title and repository picker share the first line; the status filter has a line of its own.
  const title = page.getByRole('heading', { name: 'Tasks', level: 1 });
  const repo = page.getByRole('button', { name: /All Repos/ });
  const status = page.getByRole('combobox', { name: 'Task status' });
  const [titleBox, repoBox, statusBox] = await Promise.all([title, repo, status].map(locator => locator.boundingBox()));
  expect(Math.abs(repoBox!.y + repoBox!.height / 2 - (titleBox!.y + titleBox!.height / 2))).toBeLessThan(4);
  expect(statusBox!.y).toBeGreaterThanOrEqual(repoBox!.y + repoBox!.height);
  // The picker takes the rest of the line, so its label and count show whole.
  expect(repoBox!.width).toBeGreaterThan(250);
  await expect(repo).toContainText('All Repos');
  expect(await repo.evaluate(node => [...node.querySelectorAll('.truncate')].every(label => label.scrollWidth <= label.clientWidth))).toBe(true);

  // A phone drops the summary from the third line: runs, agent and type only.
  await expect(cards.getByTestId('task-card-summary').first()).toBeHidden();
  // The repository name is whole: `propr` never becomes `pr…`.
  const repoNames = await cards.evaluateAll(nodes => nodes.map(card => {
    const name = card.querySelector('[title="integry/propr"]') as HTMLElement | null;
    return name ? name.scrollWidth <= name.clientWidth : true;
  }));
  expect(repoNames.every(Boolean)).toBe(true);
  // No trailing drill-in chevron: the title links to the task.
  await expect(cards.locator('svg.lucide-chevron-right')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await capture(page, 'tasks-cards-390');
});

test('768px cards open their runs inline as reviews and fixes, with review scores and a health track', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/tasks');
  const card = page.locator('[data-testid="task-card"]').first();
  await expect(card).toBeVisible();
  // The newest four of eight runs: two fixes that left the code at 6/10 and 5/10, then the run in flight.
  await expect(card.locator('[data-testid="run-track"] [data-outcome]')).toHaveCount(4);
  expect(await card.locator('[data-testid="run-track"] [data-outcome]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-outcome'))))
    .toEqual(['passed', 'findings', 'findings', 'active']);
  await expect(card.locator('svg.lucide-chevron-right')).toHaveCount(0);

  await card.getByRole('button', { name: '8 runs' }).click();
  const runs = card.getByRole('list', { name: 'Earlier runs' });
  await expect(runs.getByRole('listitem')).toHaveCount(7);
  // Oldest last: Run 1, the initial review at 4/10, and Run 3, the review that found two issues at 6/10.
  await expect(runs.getByTestId('work-type-badge').filter({ hasText: 'Review' })).toHaveCount(2);
  await expect(runs.getByTestId('run-score')).toHaveText(['[6]', '[4]']);
  await expect(runs.getByRole('listitem').filter({ hasText: 'Initial review' }).getByTestId('run-score')).toHaveText('[4]');
  await capture(page, 'tasks-cards-768-runs');
});

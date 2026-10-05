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
  // No trailing drill-in chevron: the title links to the task. No caret either: a card never opens its runs in place.
  await expect(cards.locator('svg.lucide-chevron-right, svg.lucide-chevron-down')).toHaveCount(0);
  await expect(cards.getByTestId('run-count').locator('xpath=self::button')).toHaveCount(0);
  // A long title takes a second line rather than ending a few words in.
  const titleLines = await cards.locator('.task-title').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height / 20)));
  expect(Math.max(...titleLines)).toBe(2);
  // The lines sit 6px apart, and the divider is a light rule inset to the content's edges.
  const rhythm = await cards.first().evaluate(card => {
    const body = card.querySelector('[data-testid="task-card-body"]') as HTMLElement;
    const style = getComputedStyle(body);
    const [chips, title, meta] = [...body.firstElementChild!.children].map(line => line.getBoundingClientRect());
    return {
      gaps: [Math.round(title.top - chips.bottom), Math.round(meta.top - title.bottom)],
      padding: [style.paddingTop, style.paddingBottom],
      border: style.borderBottomColor,
      inset: [Math.round(body.getBoundingClientRect().left - card.getBoundingClientRect().left), Math.round(card.getBoundingClientRect().right - body.getBoundingClientRect().right)],
    };
  });
  expect(rhythm).toEqual({ gaps: [6, 6], padding: ['12px', '12px'], border: 'rgb(241, 245, 249)', inset: [16, 16] });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await capture(page, 'tasks-cards-390');
});

test('768px cards stay flat: the run track shows the trend and a tap opens the task, whose timeline lists the runs', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/tasks');
  const card = page.locator('[data-testid="task-card"]').first();
  await expect(card).toBeVisible();
  // The newest four of eight runs: two fixes that left the code at 6/10 and 5/10, then the run in flight.
  await expect(card.locator('[data-testid="run-track"] [data-outcome]')).toHaveCount(4);
  expect(await card.locator('[data-testid="run-track"] [data-outcome]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-outcome'))))
    .toEqual(['passed', 'findings', 'findings', 'active']);
  // No caret to open the runs under the card, and no chevron at its end.
  await expect(card.getByRole('button', { name: '8 runs' })).toHaveCount(0);
  await expect(card.locator('svg.lucide-chevron-right, svg.lucide-chevron-down')).toHaveCount(0);
  await capture(page, 'tasks-cards-768');

  await card.getByRole('img', { name: '8 runs' }).click();
  await expect(page).toHaveURL(/pr-2664-run-0/);
});

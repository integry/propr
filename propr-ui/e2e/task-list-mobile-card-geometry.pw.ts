import { expect, test, type Page } from '@playwright/test';
import { ago, capture, fixture, tag } from './task-list-desktop.fixture';

/**
 * The widest first lines a real ledger produces: a PR chip with attachments, a
 * task with no issue (a report) whose chip is its id, a long repository,
 * Completed and Cancelled, and two-digit minute ages, over cards with runs.
 */
const longRepository = { repository: 'integry/propr-desktop-workspaces-release', repositoryOwner: 'integry', repositoryName: 'propr-desktop-workspaces-release' };
const shot = (name: string) => ({ type: 'image', title: name, url: `https://github.com/user-attachments/assets/${name}` });
const run = (id: string, fields: Record<string, unknown>, minutes: number, status = 'completed') => ({
  id, ...longRepository, status, createdAt: ago(minutes), processedAt: ago(minutes), completedAt: ago(minutes - 4),
  llmProvider: 'codex', model: 'gpt-6-astra', ...fields,
});
const extremes = [
  ...[12, 19, 33].map((minutes, index) => run(`pr-46-run-${index}`, {
    issueNumber: 46, prNumber: 46, linkedIssueNumber: 41, title: `Ultrafix PR #46: ${tag(41)} Keep the release workspace selectable after a restart`,
    subtitle: 'Restore the selection when the workspace list reloads', previewMedia: index === 0 ? [shot('a'), shot('b'), shot('c'), shot('d'), shot('e'), shot('f'), shot('g'), shot('h'), shot('i'), shot('j'), shot('k'), shot('l')] : undefined,
  }, minutes)),
  ...[14, 27].map((minutes, index) => run(`pr-49-run-${index}`, {
    issueNumber: 49, prNumber: 49, linkedIssueNumber: 48, title: `Review PR #49: ${tag(48)} Cancel queued release builds when a newer tag lands`,
  }, minutes, index === 0 ? 'cancelled' : 'completed')),
  run('3f9c2e81a4d7b6c5', { title: 'Weekly repository health report for the release workspaces' }, 58, 'cancelled'),
  run('7a4b1c9d2e3f4a5b', { title: 'Dependency audit report', previewMedia: [shot('audit')] }, 45),
];

const routeExtremes = (page: Page) => page.route(url => url.pathname === '/api/tasks', route => route.fulfill({ json: { tasks: extremes, total: 4, totalRuns: extremes.length } }));

/** Every card and the list around it, in CSS pixels. */
const measure = (page: Page) => page.evaluate(() => {
  const box = (node: Element) => node.getBoundingClientRect();
  const overflow = (node: Element) => ({ scroll: node.scrollWidth, client: node.clientWidth });
  const cards = [...document.querySelectorAll<HTMLElement>('[data-testid="task-card"]')];
  return {
    viewport: window.innerWidth,
    ledger: overflow(document.querySelector('.task-ledger')!),
    ledgerCards: overflow(document.querySelector('.task-ledger-cards')!),
    cards: cards.map(card => {
      const body = card.querySelector('[data-testid="task-card-body"]')!;
      const required = [...card.querySelectorAll('[data-testid="task-card-entity"], [data-testid="preview-count"], [data-testid="task-card-status"], [data-testid="task-card-age"] time, [data-testid="run-count"]')];
      const repo = card.querySelector('[data-testid="task-card-repository"]') as HTMLElement;
      // How wide the repository's first ten characters set in its own font.
      const probe = document.createElement('span');
      probe.style.font = getComputedStyle(repo).font;
      probe.textContent = repo.textContent!.slice(0, 10);
      document.body.append(probe);
      const tenChars = probe.getBoundingClientRect().width;
      probe.remove();
      // A line that clips its overflow hides whatever wraps past it, so a chip there is not on screen.
      const clip = (node: Element) => {
        for (let parent = node.parentElement; parent && parent !== card; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflow !== 'visible') return box(parent);
        }
        return box(card);
      };
      return {
        overflow: overflow(card),
        bodyRight: box(body).right,
        required: required.map(node => ({
          name: node.textContent?.trim() || node.getAttribute('data-testid'), left: box(node).left, right: box(node).right, width: box(node).width,
          top: box(node).top, bottom: box(node).bottom, clipTop: clip(node).top, clipBottom: clip(node).bottom,
        })),
        repoWidth: repo.getBoundingClientRect().width,
        tenChars,
        age: card.querySelector('[data-testid="task-card-age"] time')!.textContent,
      };
    }),
  };
});

for (const width of [320, 360, 390]) {
  test(`${width}px the widest cards fit: no card or list scrolls sideways and every chip, status and age is on screen`, async ({ page }) => {
    await fixture(page);
    await routeExtremes(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/tasks');
    await expect(page.locator('[data-testid="task-card"]')).toHaveCount(4);

    const layout = await measure(page);
    // The page passing is not proof: the list itself must not scroll sideways.
    for (const list of [layout.ledger, layout.ledgerCards]) expect(list.scroll).toBeLessThanOrEqual(list.client);
    for (const card of layout.cards) {
      expect(card.overflow.scroll).toBeLessThanOrEqual(card.overflow.client);
      for (const node of card.required) {
        expect(node.width, node.name ?? '').toBeGreaterThan(0);
        expect(node.left, node.name ?? '').toBeGreaterThanOrEqual(0);
        expect(node.right, node.name ?? '').toBeLessThanOrEqual(card.bodyRight + 0.5);
        expect(node.top, node.name ?? '').toBeGreaterThanOrEqual(node.clipTop - 0.5);
        expect(node.bottom, node.name ?? '').toBeLessThanOrEqual(node.clipBottom + 0.5);
      }
      // The repository still names itself: never cut below ten characters.
      expect(card.repoWidth).toBeGreaterThanOrEqual(card.tenChars - 0.5);
    }
    // The ages are the ones that overflowed in the field, not `Just now`.
    expect(layout.cards.map(card => card.age)).toEqual(expect.arrayContaining(['12 mins ago', '14 mins ago', '58 mins ago']));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await capture(page, `tasks-cards-extremes-${width}`);

    // Tapping a card still opens its task.
    await page.locator('[data-testid="task-card"]').nth(1).getByTestId('task-card-age').click();
    await expect(page).toHaveURL(/pr-49-run-0/);
  });
}

test('768px the widest cards keep one first line: chips, repository and status lead, the age holds the right edge', async ({ page }) => {
  await fixture(page);
  await routeExtremes(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/tasks');
  await expect(page.locator('[data-testid="task-card"]')).toHaveCount(4);
  const layout = await measure(page);
  for (const list of [layout.ledger, layout.ledgerCards]) expect(list.scroll).toBeLessThanOrEqual(list.client);
  const lines = await page.locator('[data-testid="task-card"]').evaluateAll(cards => cards.map(card => {
    const line = card.querySelector('[data-testid="task-card-heading"]')!;
    const status = card.querySelector('[data-testid="task-card-status"]')!.getBoundingClientRect();
    const repo = card.querySelector('[data-testid="task-card-repository"]')!.getBoundingClientRect();
    const age = card.querySelector('[data-testid="task-card-age"]')!.getBoundingClientRect();
    const body = card.querySelector('[data-testid="task-card-body"]')!.getBoundingClientRect();
    return { height: line.getBoundingClientRect().height, statusGap: status.left - repo.right, ageInset: body.right - age.right, sameLine: Math.abs(age.top - status.top) < 4 };
  }));
  for (const line of lines) {
    expect(line.height).toBe(20);
    expect(line.sameLine).toBe(true);
    // The status sits right after the repository name, as before; the age ends at the card's edge.
    expect(Math.round(line.statusGap)).toBe(8);
    expect(Math.round(line.ageInset)).toBe(0);
  }
  for (const card of layout.cards) expect(card.overflow.scroll).toBeLessThanOrEqual(card.overflow.client);
});

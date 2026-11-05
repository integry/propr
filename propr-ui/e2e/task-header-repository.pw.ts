import { expect, test, type Locator, type Page } from '@playwright/test';
import { ago, capture, detailsHistory, fixture, selectedRun, tasks } from './task-list-desktop.fixture';

const repositories = {
  short: { repoOwner: 'integry', repoName: 'propr' },
  acceptance: { repoOwner: 'propr-ultrafix', repoName: 'propr-desktop-acceptance-20260909' },
  // GitHub's longest owner (39) and repository (100) names.
  longest: { repoOwner: 'an-organisation-with-the-longest-handle', repoName: `a-repository-name-that-keeps-on-going-${'x'.repeat(62)}` },
};
type Repository = { repoOwner?: string; repoName?: string };

const openTask = async (page: Page, repository: Repository, path: string) => {
  await fixture(page, 'linux');
  await page.route('**/api/tasks', route => route.fulfill({ json: {
    tasks: tasks.map(task => task.id === selectedRun ? { ...task, status: 'completed' } : task),
    total: 1842, totalRuns: 14769,
  } }));
  await page.route(`**/api/task/${selectedRun}/history`, route => route.fulfill({ json: {
    history: [...detailsHistory, { state: 'COMPLETED', timestamp: ago(0), promptPath: '/tmp/acceptance-prompt.md', logsPath: '/tmp/acceptance.log' }],
    taskInfo: { title: 'Review the desktop acceptance task', type: 'pr', number: 2664, issueNumber: 2664, modelName: 'gpt-6-astra', ...repository },
  } }));
  await page.goto(path);
  if (path === '/tasks') await page.getByRole('link', { name: 'Stop work when an issue or PR withdraws intent' }).click();
};

/**
 * The repository's block spans the header, owner above name, with nothing
 * beside it; every control sits below it, none overlapping another, and
 * nothing scrolls sideways.
 */
const measureIdentity = (identity: Locator) => identity.evaluate(element => {
  const box = (node: Element) => node.getBoundingClientRect();
  const repository = element.querySelector<HTMLElement>('[data-testid="task-repository"]')!;
  const owner = box(repository.querySelector('[data-testid="task-repository-owner"]')!);
  const name = repository.querySelector<HTMLElement>('[data-testid="task-repository-name"]')!;
  const controls = [...element.querySelector('[data-testid="task-header-controls"]')!.querySelectorAll<HTMLElement>('a, button')]
    .filter(node => node.checkVisibility())
    .map(node => ({ label: node.getAttribute('aria-label') || node.textContent!.trim(), rect: box(node), action: !node.closest('[role="group"][aria-label="Git context"]') }));
  const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const header = element.closest<HTMLElement>('[data-testid="task-header-tiers"]')!;
  const padding = getComputedStyle(header);
  return {
    linkWidth: box(repository).width,
    // The header's content box: everything the repository may use.
    availableWidth: header.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight),
    ownerAboveName: owner.bottom <= box(name).top + 0.5 && Math.abs(owner.left - box(name).left) < 1,
    nameLines: Math.round(box(name).height / parseFloat(getComputedStyle(name).lineHeight)),
    nameFits: name.scrollWidth <= name.clientWidth && box(name).right <= box(element).right + 0.5,
    linkHeight: box(repository).height,
    controlsBelow: controls.every(control => control.rect.top >= box(repository).bottom),
    // The task's and pane's actions; the Git cluster's chips keep their compact inline size.
    smallestAction: Math.min(...controls.filter(control => control.action).map(control => Math.min(control.rect.width, control.rect.height))),
    overlapping: controls.flatMap((a, i) => controls.slice(i + 1).filter(b => overlaps(a.rect, b.rect)).map(b => `${a.label} × ${b.label}`)),
    clipped: controls.filter(control => control.rect.left < box(header).left - 0.5 || control.rect.right > box(header).right + 0.5).map(control => control.label),
    overflow: document.documentElement.scrollWidth > window.innerWidth || header.scrollWidth > header.clientWidth + 1,
  };
});

const expectIdentityLayout = async (identity: Locator, repository: Repository, maxNameLines: number, wraps = false) => {
  const link = identity.getByRole('link', { name: `${repository.repoOwner}/${repository.repoName}`, exact: true });
  await expect(link).toHaveAttribute('href', `https://github.com/${repository.repoOwner}/${repository.repoName}`);
  await expect(link).toHaveText(`${repository.repoOwner}/${repository.repoName}`);
  const layout = await measureIdentity(identity);
  expect(layout.linkWidth).toBeLessThanOrEqual(layout.availableWidth + 0.5);
  if (wraps) expect(layout.nameLines).toBeGreaterThan(1);
  // A name wraps only once it has used the header's whole width.
  if (layout.nameLines > 1) expect(layout.linkWidth).toBeCloseTo(layout.availableWidth, 0);
  expect(layout.ownerAboveName).toBe(true);
  expect(layout.nameLines).toBeLessThanOrEqual(maxNameLines);
  expect(layout.nameFits).toBe(true);
  expect(layout.linkHeight).toBeGreaterThanOrEqual(24);
  expect(layout.controlsBelow).toBe(true);
  expect(layout.smallestAction).toBeGreaterThanOrEqual(24);
  expect(layout.overlapping).toEqual([]);
  expect(layout.clipped).toEqual([]);
  expect(layout.overflow).toBe(false);
};

test('a laptop-width task pane gives a long repository the header width, owner above name', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await openTask(page, repositories.acceptance, '/tasks');
  await page.setViewportSize({ width: 1280, height: 820 });
  const identity = page.getByTestId('task-split-details').getByTestId('task-header-identity');
  for (const name of ['Prompt', 'Logs', 'Close task details']) await expect(identity.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(identity.getByRole('button', { name: /Follow Up/ })).toBeVisible();
  // Medium names keep to one line once nothing shares their row.
  await expectIdentityLayout(identity, repositories.acceptance, 1);
  await capture(page, 'task-repository-docked-1280');

  // The repository is the first stop in the header, then the Git cluster it leads.
  const repository = identity.getByTestId('task-repository');
  await repository.focus();
  await page.keyboard.press('Tab');
  await expect(identity.getByRole('group', { name: 'Git context' }).getByRole('link', { name: /#2664/ })).toBeFocused();
});

for (const [kind, repository] of Object.entries(repositories)) {
  test(`the narrowest docked pane keeps a ${kind} repository readable without overflow`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await openTask(page, repository, '/tasks');
    // The details pane at its 35% minimum.
    await page.getByRole('separator', { name: 'Resize task list and task details' }).focus();
    for (let step = 0; step < 6; step++) await page.keyboard.press('ArrowRight');
    const identity = page.getByTestId('task-split-details').getByTestId('task-header-identity');
    await expect.poll(() => identity.evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(400);
    await expectIdentityLayout(identity, repository, kind === 'longest' ? 4 : 1, kind === 'longest');
    if (kind !== 'short') await capture(page, `task-repository-docked-narrow-${kind}`);
  });
}

for (const [kind, repository] of Object.entries(repositories)) {
  test(`the full task page gives a ${kind} repository its own block`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await openTask(page, repository, `/tasks/${selectedRun}`);
    const identity = page.getByTestId('task-header-identity');
    await expect(page.getByTestId('task-breadcrumb')).toBeVisible();
    await expectIdentityLayout(identity, repository, kind === 'longest' ? 2 : 1);
    if (kind === 'acceptance') await capture(page, 'task-repository-full-page');
  });
}

for (const scale of [1.5, 2]) {
  test(`enlarged text at ${scale * 100}% wraps a long repository inside a docked pane`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await openTask(page, repositories.longest, '/tasks');
    await page.addStyleTag({ content: `html { font-size: ${scale * 100}% !important; }` });
    const identity = page.getByTestId('task-split-details').getByTestId('task-header-identity');
    await expectIdentityLayout(identity, repositories.longest, 8, true);
    if (scale === 2) await capture(page, 'task-repository-docked-text-200');
  });
}

for (const width of [320, 390]) {
  for (const [kind, repository] of Object.entries(repositories)) {
    test(`a ${width}px phone leads the task with its ${kind} repository, owner above name`, async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await openTask(page, repository, `/tasks/${selectedRun}`);
      const block = page.getByTestId('task-details').locator('header').filter({ visible: true }).first();
      const link = block.getByRole('link', { name: `${repository.repoOwner}/${repository.repoName}`, exact: true });
      await expect(link).toHaveAttribute('href', `https://github.com/${repository.repoOwner}/${repository.repoName}`);
      const layout = await link.evaluate(element => {
        const box = (node: Element) => node.getBoundingClientRect();
        const owner = box(element.querySelector('[data-testid="task-repository-owner"]')!);
        const name = element.querySelector<HTMLElement>('[data-testid="task-repository-name"]')!;
        const status = box(element.closest('header')!.querySelector('[data-testid="task-header-status"]')!);
        return {
          ownerAboveName: owner.bottom <= box(name).top + 0.5,
          nameLines: Math.round(box(name).height / parseFloat(getComputedStyle(name).lineHeight)),
          nameFits: name.scrollWidth <= name.clientWidth && box(name).right <= window.innerWidth,
          height: box(element).height,
          aboveStatus: box(element).bottom <= status.top,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      expect(layout.ownerAboveName).toBe(true);
      // Only GitHub's longest names wrap; nothing is cut short.
      expect(layout.nameLines).toBeLessThanOrEqual(kind === 'longest' ? 5 : 1);
      expect(layout.nameFits).toBe(true);
      expect(layout.height).toBeGreaterThanOrEqual(24);
      expect(layout.aboveStatus).toBe(true);
      expect(layout.overflow).toBe(false);
      if (kind === 'acceptance') await capture(page, `task-repository-mobile-${width}`);
    });
  }
}

// Automation reports carry no repository; partial metadata names none either.
const missing: Record<string, Repository> = { 'repository-less': {}, 'owner-only': { repoOwner: 'integry' }, 'name-only': { repoName: 'propr' } };

for (const [kind, repository] of Object.entries(missing)) {
  for (const width of [390, 1280]) {
    test(`a ${kind} task at ${width}px shows no repository link, keeping its status and title`, async ({ page }) => {
      await page.setViewportSize({ width, height: 820 });
      await openTask(page, repository, `/tasks/${selectedRun}`);
      const details = page.getByTestId('task-details');
      await expect(details.getByRole('heading', { level: 2, name: 'Review the desktop acceptance task' }).filter({ visible: true })).toBeVisible();
      await expect(details.locator('[data-testid="task-header-status"], [data-testid="task-status-badge"]').filter({ visible: true }).first()).toContainText('Completed');
      // The identity link this header adds is omitted outright, not rendered as `undefined/undefined`.
      await expect(page.getByTestId('task-repository')).toHaveCount(0);
      await expect(page.locator('[aria-label*="undefined"]')).toHaveCount(0);
      expect(await page.getByTestId('task-details').innerText()).not.toMatch(/undefined/);
      if (kind === 'repository-less') await capture(page, `task-repository-none-${width}`);
    });
  }
}

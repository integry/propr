/** The timeline's sticky heading stays above every rail, node and step that scrolls beneath it. */
import { expect, test, type Page } from '@playwright/test';
import { ago, capture, fixture, historicalRun, selectedRun } from './task-list-desktop.fixture';

// A long expanded run, so the timeline outgrows the pane and scrolls under its heading.
const longHistory = (start: number) => [
  { state: 'PENDING', timestamp: ago(start), metadata: { model: 'gpt-6-astra' } },
  ...Array.from({ length: 24 }, (_, index) => ({
    state: 'CLAUDE_EXECUTION', timestamp: ago(start - (index + 1) * 0.1),
    metadata: { model: 'gpt-6-astra', description: `Layering checkpoint ${index + 1}` },
  })),
];

async function longRuns(page: Page) {
  for (const [run, start] of [[selectedRun, 3], [historicalRun, 39]] as const) {
    await page.route(`**/api/task/${run}/history`, route => route.fulfill({ json: {
      history: longHistory(start),
      taskInfo: { title: 'Stop work when an issue or PR withdraws intent', type: 'pr', number: 2664, issueNumber: 2664, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra' },
    } }));
  }
}

/** Points inside the visible heading where the timeline's own content paints on top of it. */
async function coveredHeadingPoints(page: Page, scope: string) {
  return page.evaluate(scope => {
    const root = document.querySelector(scope) ?? document;
    const heading = root.querySelector<HTMLElement>('[data-testid="task-timeline-heading"]')!;
    const timeline = heading.closest<HTMLElement>('[data-testid="task-timeline-scroll"]')!;
    const scroller = heading.closest<HTMLElement>('[data-short-workspace]') ?? heading.closest<HTMLElement>('[data-testid="task-workspace-scroll"]')!;
    const box = heading.getBoundingClientRect();
    const port = scroller.getBoundingClientRect();
    const top = Math.max(box.top, port.top, 0) + 1;
    const bottom = Math.min(box.bottom, port.bottom, window.innerHeight) - 1;
    const covered: string[] = [];
    for (let y = top; y < bottom; y += 4) {
      for (let x = box.left + 1; x < box.right - 1; x += 3) {
        const hit = document.elementFromPoint(x, y);
        // The app's own chrome (a phone's compact bar) may cover a heading scrolled away with the page.
        if (hit && timeline.contains(hit) && !heading.contains(hit)) covered.push(`${hit.getAttribute('data-testid') ?? hit.tagName}@${Math.round(x)},${Math.round(y)}`);
      }
    }
    return covered;
  }, scope);
}

/** Scrolls the whole timeline under its heading, collecting anything painted over it. */
async function scrollUnderHeading(page: Page, scope: string, owner: 'task-workspace-scroll' | 'task-details') {
  // Hit-testing follows paint order; the trunk only opts out of pointer events.
  await page.addStyleTag({ content: '[data-testid="run-timeline-trunk"] { pointer-events: auto !important; }' });
  const scroller = page.locator(scope).getByTestId(owner);
  const max = await scroller.evaluate(node => node.scrollHeight - node.clientHeight);
  expect(max).toBeGreaterThan(200);
  const covered: string[] = [];
  for (let top = 0; top <= max + 40; top += 40) {
    await scroller.evaluate((node, top) => { node.scrollTop = top; }, top);
    covered.push(...(await coveredHeadingPoints(page, scope)).map(point => `${top}: ${point}`));
  }
  return covered;
}

for (const platform of [undefined, 'linux'] as const) {
  for (const { name, width, path } of [
    { name: 'docked', width: 1280, path: `/tasks?task=${selectedRun}` },
    { name: 'full-page split', width: 1280, path: `/tasks/${selectedRun}` },
    { name: 'full-page stacked', width: 700, path: `/tasks/${selectedRun}` },
  ]) {
    test(`${platform ?? 'web'} ${name} timeline rails and nodes stay beneath the sticky heading`, async ({ page }) => {
      await page.setViewportSize({ width, height: 820 });
      await fixture(page, platform);
      await longRuns(page);
      await page.goto(path);
      const scope = name === 'docked' ? '[data-testid="task-split-details"]' : 'body';
      const pane = page.locator(scope);
      await expect(pane.getByTestId('run-timeline-run')).toHaveCount(8);
      await expect(pane.getByText('Layering checkpoint 24', { exact: true }).filter({ visible: true })).toBeVisible();
      await expect(pane.getByTestId('task-timeline-heading')).toHaveCSS('position', 'sticky');

      // Midway, the expanded run's trunk and steps pass beneath the pinned heading.
      const scroller = pane.getByTestId('task-workspace-scroll');
      await scroller.evaluate(node => { node.scrollTop = 160; });
      const [heading, trunk] = await Promise.all([pane.getByTestId('task-timeline-heading').boundingBox(), pane.getByTestId('run-timeline-trunk').boundingBox()]);
      expect(trunk!.y).toBeLessThan(heading!.y);
      expect(trunk!.y + trunk!.height).toBeGreaterThan(heading!.y + heading!.height);
      if (!platform) await capture(page, `timeline-heading-layering-${name.replace(/\W+/g, '-')}`);
      expect(await scrollUnderHeading(page, scope, 'task-workspace-scroll')).toEqual([]);

      const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(pageWidth).toBeLessThanOrEqual(0);
    });
  }
}

test('an earlier run keeps its way back to Run 8 above the timeline with enlarged text', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await fixture(page);
  await longRuns(page);
  await page.goto(`/tasks?task=${historicalRun}`);
  await page.addStyleTag({ content: 'html { font-size: 150%; }' });
  const scope = '[data-testid="task-split-details"]';
  const pane = page.locator(scope);
  const back = pane.getByTestId('task-timeline-heading').getByRole('button', { name: /Run 8$/ });
  await expect(back).toBeVisible();
  // The enlarged header leaves the pane too short for its own workspace, so the whole task scrolls under the heading.
  await expect(pane.getByTestId('task-details')).toHaveAttribute('data-short-workspace', 'true');
  expect(await scrollUnderHeading(page, scope, 'task-details')).toEqual([]);
  await back.click();
  await expect(page).toHaveURL(new RegExp(`task=${selectedRun}`));
});

for (const width of [320, 390]) {
  test(`${width}px phone timeline heading is never painted over`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await fixture(page);
    await longRuns(page);
    await page.goto(`/tasks/${selectedRun}`);
    await expect(page.getByTestId('run-timeline-run')).toHaveCount(8);
    expect(await scrollUnderHeading(page, 'body', 'task-details')).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
}

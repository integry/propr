import { expect, test } from '@playwright/test';
import { DESKTOP_UI_COMMAND_EVENT } from '../src/desktop/useDesktopNativeCommands';
import { capture, fixRun, fixture } from './task-list-desktop.fixture';

test('390px the full-page timeline wraps each run\'s result, time and duration under a readable summary', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // An open fix shows its commit, the widest result a run has.
  await page.goto(`/tasks/${fixRun}`);
  const timeline = page.getByRole('list', { name: 'Runs' });
  const runRows = timeline.getByTestId('run-timeline-run');
  await expect(runRows).toHaveCount(8);
  const open = runRows.nth(1).locator(':scope > button');
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  await expect(open.getByTestId('run-commit')).toBeVisible();
  await expect(open.getByTestId('run-commit')).toHaveText('a81d3f5');
  for (const row of await runRows.all()) {
    const layout = await row.locator(':scope > button').evaluate(button => {
      const box = button.getBoundingClientRect();
      const summary = button.querySelector('[title].truncate')!.getBoundingClientRect();
      const meta = button.querySelector('[data-testid="run-timeline-meta"]')!.getBoundingClientRect();
      return { overflows: button.scrollWidth > button.clientWidth, right: box.right, summary: summary.width, summaryBottom: summary.bottom, meta };
    });
    expect(layout.overflows).toBe(false);
    // The summary keeps the row; what followed it moves to a second line, still ending on the row's right edge.
    expect(layout.summary).toBeGreaterThan(120);
    expect(layout.meta.top).toBeGreaterThanOrEqual(layout.summaryBottom - 1);
    expect(layout.meta.right).toBeLessThanOrEqual(layout.right);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(timeline).toContainText('Fixed seedCommit test');
  await capture(page, 'task-timeline-fix-390');
});

// Exercise the production task page and TaskStatusTable, with long execution labels
// supplied through its history API (all other requests use the privacy-safe fixture).
const layoutsToCheck = [
  ...[320, 360, 390, 430, 520, 667, 768, 915, 1024, 1199, 1200, 1280, 1920, 2560].map(width => ({ width, hasTouch: true, hideSidebar: false })),
  ...[520, 768, 1024, 1199, 1200, 1280, 1920, 2560].map(width => ({ width, hasTouch: false, hideSidebar: false })),
  ...[true, false].map(hasTouch => ({ width: 1920, hasTouch, hideSidebar: true })),
];
for (const { width, hasTouch, hideSidebar } of layoutsToCheck) {
  test(`${width}px ${hasTouch ? 'touch' : 'mouse'} ${hideSidebar ? 'sidebar hidden' : 'sidebar visible'} expanded steps keep readable labels and usable run controls`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: hasTouch && [667, 915].includes(width) ? 390 : 1000 }, hasTouch });
    const page = await context.newPage();
    await fixture(page, hideSidebar ? 'linux' : undefined);
    const label = 'Review CheckoutSummary.tsx and verify the checkout confirmation keyboard navigation';
    await page.route(`**/api/task/${fixRun}/history`, async route => {
      // No live server is needed: use the same fixture history with a realistic long label.
      await route.fulfill({ json: {
        history: [
          { state: 'PENDING', timestamp: '2026-10-01T11:20:00Z' },
          { state: 'CLAUDE_EXECUTION', timestamp: '2026-10-01T11:20:12Z', metadata: { description: label } },
          { state: 'COMPLETED', timestamp: '2026-10-01T11:22:00Z' },
        ],
        taskInfo: { title: 'Followup: Update 2', subtitle: 'Fixed seedCommit test', type: 'pr', number: 2664, issueNumber: 2664, repoOwner: 'integry', repoName: 'propr' },
      } });
    });
    await page.route(`**/api/task/${fixRun}/file-changes`, route => route.fulfill({ json: { taskId: fixRun, files: [] } }));
    await page.goto(`/tasks/${fixRun}`);
    const runs = page.getByTestId('run-timeline-run');
    await expect(runs).toHaveCount(8);
    if (hideSidebar) {
      await page.evaluate(event => window.dispatchEvent(new CustomEvent(event, { detail: 'toggle-sidebar' })), DESKTOP_UI_COMMAND_EVENT);
      await expect(page.locator('.desktop-sidebar-hidden')).toBeVisible();
    }
    const assertRunControlHeights = async () => {
      const heights = await runs.locator(':scope > button').evaluateAll(buttons =>
        buttons.map(button => button.getBoundingClientRect().height));
      expect(heights).toHaveLength(8);
      for (const [index, height] of heights.entries()) {
        expect(height, `Run ${index + 1} at ${width}px; all heights: ${heights}`).toBeGreaterThanOrEqual(hasTouch || width < 1024 ? 44 : 32);
      }
      if (!hasTouch && (width === 2560 || hideSidebar)) {
        // Short closed rows retain the ordinary wide mouse density.
        expect(heights[0]).toBeGreaterThanOrEqual(28);
        expect(heights[0]).toBeLessThanOrEqual(40);
      }
    };
    const open = runs.nth(1).locator(':scope > button');
    const steps = page.getByRole('list', { name: 'Run steps' });
    await expect(steps).toContainText(label);
    const workspace = await page.getByTestId('task-workspace-scroll').boundingBox();
    const pane = await page.getByTestId('task-timeline-scroll').boundingBox();
    const output = await page.getByTestId('task-output-scroll').boundingBox();
    if (workspace!.width >= 960) {
      expect(pane!.width).toBeGreaterThanOrEqual(576);
      expect((await page.getByTestId('task-result-pane').boundingBox())!.width).toBeGreaterThanOrEqual(384);
      expect(output!.x).toBeGreaterThanOrEqual(pane!.x + pane!.width);
      expect(output!.y).toBe(pane!.y);
    } else {
      expect(pane!.width).toBeCloseTo(workspace!.width, 0);
      expect(output!.y).toBeGreaterThanOrEqual(pane!.y + pane!.height);
    }
    const timelineWidth = await steps.evaluate(el => el.getBoundingClientRect().width);
    if (width >= 667) expect(timelineWidth).toBeGreaterThanOrEqual(528);
    const layouts = await steps.locator(':scope > li').evaluateAll(rows => rows.map(row => {
      const [time, content, duration] = Array.from(row.children).slice(1) as HTMLElement[];
      const box = (element: Element) => element.getBoundingClientRect().toJSON();
      return { time: box(time), label: box(content), duration: box(duration),
        height: row.getBoundingClientRect().height,

        overflow: [row, time, content, duration].some(el => el.scrollWidth > el.clientWidth),
        text: row.textContent };
    }));
    for (const layout of layouts) {
      expect(layout.overflow, JSON.stringify(layout)).toBe(false);
      if (width <= 520) {
        expect(layout.height).toBeGreaterThanOrEqual(24);
        expect(layout.height).toBeLessThanOrEqual(32);
        expect(layout.time.width).toBeGreaterThanOrEqual(48);
        expect(layout.time.width).toBeLessThanOrEqual(64);
        expect(layout.label.width).toBeGreaterThan(70);
        expect(layout.label.top).toBe(layout.time.top);
        expect(layout.duration.top).toBe(layout.label.top);
        expect(layout.duration.left).toBeGreaterThanOrEqual(layout.label.right);
        expect(layout.duration.width).toBeGreaterThanOrEqual(48);
      } else {
        expect(layout.label.width).toBeGreaterThanOrEqual(260);
        const run = await open.evaluate(button => ({
          summary: button.querySelector('[title].truncate')!.getBoundingClientRect().left,
          duration: button.querySelector('[data-testid="run-timeline-meta"]')!.lastElementChild!.getBoundingClientRect().right,
        }));
        expect(layout.label.left).toBe(run.summary);
        expect(layout.duration.right).toBe(run.duration);
        expect(layout.time.top).toBe(layout.label.top);
      }
    }
    expect(layouts[0].text).toContain('Task Queued');
    expect(layouts[1].text).toContain(label);

    expect(layouts[1].text).toMatch(/1m 48s$/);
    expect(layouts[2].text).toContain('Task Completed');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const scroller = page.getByTestId('run-timeline-scroll');
    expect(await scroller.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await open.scrollIntoViewIfNeeded();
    const control = await open.boundingBox();
    expect(control!.x).toBeGreaterThanOrEqual(0);
    expect(control!.x + control!.width).toBeLessThanOrEqual(width);
    await assertRunControlHeights();
    if (width <= 520) {
      const disclosure = steps.getByRole('button', { name: label, exact: true });
      await disclosure[hasTouch ? 'tap' : 'click']();
      await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
      const full = page.locator(`[id="${await disclosure.getAttribute('aria-controls')}"]`);
      await expect(full).toBeVisible();
      expect(await full.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await disclosure.focus();
      await page.keyboard.press('Enter');
      await expect(full).not.toBeVisible();
    }
    const previewName = `task-step-labels-${width}-${hasTouch ? 'touch' : 'mouse'}${hideSidebar ? '-sidebar-hidden' : ''}`;
    await capture(page, previewName);
    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      await scroller.screenshot({ animations: 'disabled', path: `../.propr/previews/${previewName}-timeline.png` });
    }
    await open[hasTouch ? 'tap' : 'click']();
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await expect(steps).toHaveCount(0);
    await assertRunControlHeights();
    // Chromium holds a short tap's press open for 150ms after the click, and its delayed release also
    // cancels a Space press in progress on the button. A test hands over to the keyboard sooner than a
    // person, and on a loaded host that release can land between Space's keydown and keyup; the pointer
    // moving on ends the tap's press now, so Space reaches the button as it would for anyone.
    if (hasTouch) await open.hover();
    await open.focus();
    await page.keyboard.press('Enter');
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    await expect(steps).toContainText(label);
    await page.keyboard.press('Space');
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await open[hasTouch ? 'tap' : 'click']();
    await expect(steps).toContainText(label);
    // Selecting another run still loads its own history and leaves just that run open.
    await runs.nth(2).locator(':scope > button')[hasTouch ? 'tap' : 'click']();
    await expect(runs.nth(2).locator(':scope > button')).toHaveAttribute('aria-expanded', 'true');
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await expect(steps).toHaveCount(1);
    await expect(steps).toContainText('Review the withdrawal handlers');
    await assertRunControlHeights();
    await context.close();
  });
}

for (const width of [320, 390, 1440]) {
  test(`${width}px step details remain accessible through compact disclosure`, async ({ page }) => {
    await fixture(page);
    await page.setViewportSize({ width, height: 844 });
    await page.route(`**/api/task/${fixRun}/history`, route => route.fulfill({ json: {
      history: [
        { state: 'FAILED', timestamp: '2026-10-01T11:20:00Z', metadata: { terminalReason: 'timed_out' } },
        { state: 'COMPLETED', timestamp: '2026-10-01T11:21:00Z', metadata: { event: 'network.egress', networkEgress: { mode: 'restricted', deniedConnections: 1, deniedHosts: [{ host: 'example.com', count: 1 }] } } },
        { state: 'FAILED', timestamp: '2026-10-01T11:22:00Z', metadata: { pushFailure: { diagnosis: { classification: 'network', summary: 'Remote connection failed', unblockUrls: [] }, rung: 'rescue_ref', recoveryInstruction: 'Fetch the saved branch to recover your changes.' } } },
      ],
      taskInfo: { title: 'Followup: Update 2', type: 'pr', number: 2664, repoOwner: 'integry', repoName: 'propr' },
    } }));
    await page.goto(`/tasks/${fixRun}`);
    const steps = page.getByRole('list', { name: 'Run steps' });
    const rows = steps.locator(':scope > li');
    await expect(rows).toHaveCount(3);
    for (const [index, testId] of ['task-terminal-reason', 'network-egress', 'push-failure'].entries()) {
      const row = rows.nth(index);
      const detail = row.getByTestId(testId);
      if (width < 640) {
        await expect(detail).not.toBeVisible();
        expect((await row.boundingBox())!.height).toBeLessThanOrEqual(32);
        await row.getByRole('button').click();
      }
      await expect(detail).toBeVisible();
      expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    await capture(page, `task-step-disclosures-${width}`);
  });
}

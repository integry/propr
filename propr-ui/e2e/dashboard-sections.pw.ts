import { expect, test } from '@playwright/test';
import { USAGE_TIPS_CATALOG } from '@propr/shared';
import { now, minutesAgo, running, attention, outcomes, user, dashboardResponses, fixture, respond, openDashboard, captureTarget, capture } from './dashboard-sections.fixture';

test('the activity briefing gives a concise overview and sits flush against the panes', async ({ page }) => {
  await fixture(page, { width: 1440, height: 900 });
  // Exercise the admin-only detection wrapper that formerly left an empty gap.
  await page.route('**/api/auth/user', route => route.fulfill({ json: { ...user, permissions: ['instance.manage_agents'] } }));
  await page.goto('/');
  const summary = page.getByTestId('dashboard-summary');
  await expect(summary).toContainText('Dashboard improvements are being tested, while recent fixes await review.');
  await expect(summary).not.toContainText(/#2456|step 3|workspace|\.tsx/);
  await expect.poll(async () => {
    const bar = await summary.boundingBox();
    const pane = await page.getByTestId('happening-now-section').boundingBox();
    return Math.round(pane!.y - (bar!.y + bar!.height));
  }).toBe(0);
  await captureTarget(page.locator('main'), 'dashboard-live-overview');
});

test('the summary reserves space while loading and restores cached prose on reload', async ({ page }) => {
  await fixture(page, { width: 1440, height: 900 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/dashboard/narrative?**', async route => {
    await held;
    await route.fulfill({ json: dashboardResponses(attention, running)['/api/dashboard/narrative'] });
  });
  await page.goto('/');
  const bar = page.getByTestId('dashboard-summary');
  await expect(bar).toContainText('Gathering the latest activity…');
  await expect(page.getByTestId('happening-now-section')).toBeVisible();
  const before = await page.getByTestId('happening-now-section').boundingBox();
  await captureTarget(page.locator('main'), 'dashboard-summary-loading');
  release();
  await expect(bar).toContainText('Dashboard improvements are being tested');
  const after = await page.getByTestId('happening-now-section').boundingBox();
  expect(after!.y).toBe(before!.y);
  await page.route('**/api/dashboard/narrative?**', route => route.abort());
  await page.reload();
  await expect(bar).toContainText('Dashboard improvements are being tested');
  await expect(bar).toContainText('Saved');
  await captureTarget(page.locator('main'), 'dashboard-summary-cached');
});

test('desktop shows every section with running work in the main column', async ({ page }) => {
  await openDashboard(page, { width: 1440, height: 1400 });

  await expect(page.getByTestId('header-scope-slot').getByRole('button', { name: /All Repos/ })).toBeVisible();
  await expect(page.getByTestId('dashboard-scope-bar')).toBeHidden();
  await expect(page.getByTestId('summary-strip')).toHaveCount(0);
  await expect(page.getByTestId('needs-attention-panel')).toBeVisible();
  // Every running row is running, so no row carries a phase badge; the type
  // badge leads the title instead, and the backend prefix is gone from it.
  const happeningNow = page.getByTestId('happening-now-section');
  await expect(happeningNow).not.toContainText('Implementing');
  await expect(happeningNow.locator('.animate-spin')).toHaveCount(0);
  // No spinner, but no blank row either: every running row says what it is
  // doing now, so a hung agent is not indistinguishable from a busy one.
  const rows = happeningNow.getByTestId('happening-now-list').locator('li');
  const subPhases = happeningNow.getByTestId('running-sub-phase');
  await expect(subPhases).toHaveCount(await rows.count());
  for (const text of await subPhases.allInnerTexts()) expect(text.trim()).not.toBe('');
  await expect(rows.nth(2).getByTestId('running-last-output')).toHaveText('last output just now');
  await expect(rows.nth(3).getByTestId('running-step')).toHaveText('step 3/5');
  await expect(happeningNow.getByTestId('work-type-badge').first()).toHaveText('Implement');
  await expect(happeningNow).not.toContainText('New Issue:');
  await expect(page.getByTestId('queue-summary')).toContainText('All agents are busy');
  // The completed feed names no state, prints no bare "completed" line, and
  // shows a score only on the review.
  const completed = page.getByTestId('completed-section');
  await expect(completed.getByRole('heading')).toHaveText('Completed');
  await expect(completed.getByTestId('completed-list')).not.toContainText('Completed');
  await expect(completed.getByTestId('completed-score')).toHaveCount(1);
  await expect(completed).toContainText('2 issues found: Missing timeline test');
  await expect(completed).not.toContainText('Fix PR #2494');
  await expect(completed.getByRole('searchbox', { name: 'Filter completed work by title' })).toBeVisible();
  await expect(completed.getByRole('button', { name: /Last 24 hours|Last 7 days/ })).toHaveCount(0);
  // The stats panel shows the numbers alone, without a change line or its footnote.
  await expect(page.getByTestId('historical-stats-section')).not.toContainText('Compared with');
  // One word per metric label: `RECORDED SPEND` does not fit a third of this
  // column, and a heading cut to `RECORDED SP…` reads as a broken grid.
  await expect(page.getByTestId('historical-stats-section')).toContainText('Spend');
  await expect(page.getByTestId('historical-stats-section')).not.toContainText('RECORDED SP');

  // Five active rows before the list is expanded.
  await expect(page.getByTestId('happening-now-list').locator('li')).toHaveCount(5);

  // The navigation column is whole: nav, then telemetry, then the account.
  const sidebar = page.locator('aside').first();
  await expect(sidebar.getByRole('link', { name: 'Settings' })).toBeVisible();
  for (const text of ['Usage', 'Dana Okonkwo']) await expect(sidebar.getByText(text)).toBeVisible();

  // Every action in the attention column starts on the same vertical line.
  const actionLefts = await page.getByTestId('needs-attention-panel').getByRole('link', { name: /^(Open|Review)\b/ }).evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().left)));
  expect(actionLefts.length).toBeGreaterThan(1);
  expect(new Set(actionLefts).size).toBe(1);

  // The repository chip in the narrow column drops its owner so all three
  // chips fit the line whole; nothing in the column is cut off.
  const attentionPanel = page.getByTestId('needs-attention-panel');
  await expect(attentionPanel.getByTitle('example/workspace').first()).toHaveText('workspace');
  const clipped = await attentionPanel.locator('.truncate').evaluateAll(nodes =>
    nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent ?? ''));
  expect(clipped).toEqual([]);

  // One footer closes the running list: the queue summary and the expand
  // control share the bar instead of the link floating above it.
  const footer = page.getByTestId('happening-now-footer');
  await expect(footer.getByTestId('queue-summary')).toBeVisible();
  await expect(footer.getByRole('button', { name: 'Show 2 more' })).toBeVisible();

  await capture(page, 'dashboard-desktop');

  await footer.getByRole('button', { name: 'Show 2 more' }).click();
  await expect(page.getByTestId('happening-now-list').locator('li')).toHaveCount(7);
  await expect(footer.getByRole('button', { name: 'Show fewer' })).toBeVisible();
  await expect(page.getByTestId('daily-completions-chart')).toBeVisible();
  await page.locator('.recharts-surface').first().waitFor({ state: 'visible' });

  // Height means nothing without a number attached to it: the fixture's
  // busiest day is 8 completions, so the top gridline says 8 and the baseline
  // says 0. Without them the tallest point could be 8 or 800.
  const chart = page.getByTestId('daily-completions-chart');
  const ticks = chart.locator('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value');
  await expect(ticks).toHaveCount(2);
  expect((await ticks.allTextContents()).map(text => text.trim()).sort()).toEqual(['0', '8']);

  // A line, not a row of bars: a trend over days is a continuous quantity.
  await expect(chart.locator('.recharts-area-curve')).toBeVisible();
  await expect(chart.locator('.recharts-bar')).toHaveCount(0);
  // Both gridlines are drawn, and dashed so they stay behind the data.
  const grid = chart.locator('.recharts-cartesian-grid-horizontal line');
  await expect(grid).toHaveCount(2);
  expect(await grid.first().getAttribute('stroke-dasharray')).toBe('3 3');

  // Only the day still in progress carries a marker; settled days are the
  // line alone.
  const markers = chart.locator('.recharts-area-dots circle');
  await expect(markers).toHaveCount(1);

  // The marker for the latest day is filled and ringed, and it is plotted on
  // the right edge of the plot area: without a margin the size of its own
  // radius, half of it hangs past the vertical that the period toggle and the
  // analytics link sit on.
  const [lastMarker, plot] = await Promise.all([markers.last().boundingBox(), chart.boundingBox()]);
  const railRight = await page.getByTestId('historical-stats-section').locator('a', { hasText: 'Full analytics' })
    .evaluate(node => Math.round(node.getBoundingClientRect().right));
  expect(lastMarker).not.toBeNull();
  expect(Math.round(lastMarker!.x + lastMarker!.width)).toBeLessThanOrEqual(Math.round(plot!.x + plot!.width));
  expect(Math.round(lastMarker!.x + lastMarker!.width)).toBeLessThanOrEqual(railRight);

});

test('the queue footer floors the running pane when the column beside it is taller', async ({ page }) => {
  // One running task against three attention items: the pane is sized by the
  // column beside it, not by its own single row. The task has been going for
  // four hours, which is the duration that used to print as `240m 00s`.
  await openDashboard(page, { width: 1440, height: 1400 }, attention.slice(0, 3), [{ ...running[0], createdAt: minutesAgo(240) }]);

  await expect(page.getByTestId('happening-now-list').locator('li')).toHaveCount(1);

  const geometry = await page.evaluate(() => {
    const box = (id: string) => (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).getBoundingClientRect();
    const section = box('happening-now-section'), footer = box('happening-now-footer');
    const row = (document.querySelector('[data-testid="happening-now-list"] li') as HTMLElement).getBoundingClientRect();
    return {
      slack: Math.round(footer.top - row.bottom), floorGap: Math.round(section.bottom - footer.bottom),
      paneHeight: Math.round(section.height), completedTop: Math.round(box('completed-section').top),
      footerBottom: Math.round(footer.bottom),
    };
  });

  // The bar closes the pane: nothing of the pane is left below it, and the
  // rule under it is the top of the next section.
  expect(geometry.floorGap).toBe(0);
  expect(geometry.completedTop).toBeGreaterThanOrEqual(geometry.footerBottom);
  // The empty space is above the bar, in the list area, rather than below it:
  // this is the 260px hole the bar used to hang over.
  expect(geometry.paneHeight).toBeGreaterThan(300);
  expect(geometry.slack).toBeGreaterThan(100);

  // A review row says what is being reviewed. `Pull request #2469` under a
  // `PR #2469` chip is the chip read twice.
  const panel = page.getByTestId('needs-attention-panel');
  await expect(panel).toContainText('Cache repository icons across dashboard sections');
  await expect(panel).not.toContainText('Pull request #');

  // Four hours reads as four hours, not as a count of 240 minutes.
  const list = page.getByTestId('happening-now-list');
  await expect(list).toContainText('4h 00m');
  await expect(list).not.toContainText('240m');

  await capture(page, 'dashboard-desktop-short-running-list');
});

test('an empty attention list keeps the panel in place with an all-clear line', async ({ page }) => {
  await openDashboard(page, { width: 1440, height: 1400 }, []);

  await expect(page.getByTestId('happening-now-section')).toBeVisible();

  // The triage panel holds the top of the right column whatever the count is.
  const panel = page.getByTestId('needs-attention-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading')).toHaveText('Needs attention (0)');
  await expect(page.getByTestId('needs-attention-empty')).toHaveText('All tasks operational — no attention required');

  const geometry = await page.evaluate(() => Object.fromEntries(
    ['needs-attention-panel', 'happening-now-section', 'completed-section', 'historical-stats-section'].map(id => {
      const rect = (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).getBoundingClientRect();
      return [id, { top: Math.round(rect.top), bottom: Math.round(rect.bottom) }];
    }),
  ));

  // Row one starts on one horizon and row two starts on one horizon, so the
  // rule between them is a single line across both columns rather than a step.
  expect(geometry['needs-attention-panel'].top).toBe(geometry['happening-now-section'].top);
  expect(geometry['historical-stats-section'].top).toBe(geometry['completed-section'].top);
  // Stats stay in the second tier; triage keeps the top of the rail.
  expect(geometry['historical-stats-section'].top).toBeGreaterThan(geometry['needs-attention-panel'].bottom - 1);

  await capture(page, 'dashboard-desktop-no-attention');
});

test('the dashboard fits a 320px viewport without horizontal overflow', async ({ page }) => {
  await openDashboard(page, { width: 320, height: 1200 });

  for (const id of ['dashboard-scope-bar', 'needs-attention-panel', 'happening-now-section'])
    await expect(page.getByTestId(id)).toBeVisible();

  const overflow = await page.evaluate(() => ({
    documentScrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
    wide: [...document.querySelectorAll('main *')]
      .filter(node => {
        let right = node.getBoundingClientRect().right;
        // Inline tokens retain their full bounds even when an ellipsis clips them.
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowX !== 'visible') {
            right = Math.min(right, parent.getBoundingClientRect().right);
          }
        }
        return right > window.innerWidth + 1;
      })
      .map(node => ({ cls: node.className, text: (node.textContent || '').slice(0, 40), right: Math.round(node.getBoundingClientRect().right), parent: (node.parentElement?.className || '').slice(0, 80) }))
      .slice(0, 5) }));
  expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  expect(overflow.wide).toEqual([]);
  await capture(page, 'dashboard-mobile');
});

test('the repository filter narrows every section and survives a reload', async ({ page }) => {
  await fixture(page, { width: 1440, height: 1000 });
  const requested: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/dashboard/') || url.pathname === '/api/stats/dashboard')
      requested.push(`${url.pathname}?${url.searchParams.get('repository')}`);
  });
  await page.goto('/');
  await expect(page.getByTestId('happening-now-section')).toBeVisible();

  await page.getByRole('button', { name: /All Repos/ }).click();
  await page.getByTestId('repo-item').filter({ hasText: 'docs' }).click();

  await expect(page).toHaveURL(/repository=example%2Fdocs/);
  await expect.poll(() => ['/api/dashboard/attention', '/api/dashboard/active', '/api/dashboard/outcomes', '/api/stats/dashboard']
      .every(pathname => requested.includes(`${pathname}?example/docs`)))
    .toBe(true);

  await page.reload();
  await expect(page.getByRole('button', { name: /docs/ })).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`dashboard cleanup shows entity rollups, stale waits and the attention footer at ${width}px`, async ({ page }) => {
    const waiting = Array.from({ length: 7 }, (_, index) => ({
      ...attention[1], id: `plan-issue:${index}`, prNumber: 735 - index, since: minutesAgo((50 + index) * 24 * 60),
      title: ['Add live model validation defaults and limits', 'Add VERSION constant', 'Add project version constant'][index % 3],
    }));
    await fixture(page, { width, height: 1000 }, waiting, []);
    await respond(page, 'dashboard/outcomes', {
      limit: 50,
      items: [...outcomes, { ...outcomes[2], id: 'task:done-5:completed', taskId: 'done-5', prNumber: 64,
        title: 'Fix PR #64: Preserve repository filters on reload', occurredAt: minutesAgo(360) }].map((item, index) => ({
        ...item, prNumber: item.prNumber ?? 2461, eventCount: index < 2 ? 3 : 1,
        earlierUpdates: index < 2 ? [
          { ...item, id: `${item.id}:prior-1`, taskId: `${item.taskId}:prior-1`, occurredAt: minutesAgo(21), detail: 'Fixed duplicate snapshot boundaries and preserved corrective operator messages through retries', score: index === 0 ? 6 : null },
          { ...item, id: `${item.id}:prior-2`, taskId: `${item.taskId}:prior-2`, occurredAt: minutesAgo(37), detail: 'Initial review found missing timeline coverage', score: index === 0 ? 4 : null },
        ] : [],
      })),
    });
    await respond(page, 'dashboard/active', { running: [], queued: [], queue: { queuedCount: 0, reason: null }, counts: { running: 0, queued: 0 } });
    await respond(page, 'dashboard/narrative', { enabled: true,
      summary: 'No work is running. Five pull requests have recent completed outcomes. Seven older review requests are waiting for attention.',
    });
    await page.route('**/api/usage-tips', route => route.fulfill({ json: { enabled: true, tips: USAGE_TIPS_CATALOG.slice(0, 2) } }));
    await page.goto('/');
    const active = page.getByTestId('happening-now-section');
    await expect(active).toContainText('No active tasks or goals running');
    await expect(active.getByRole('link', { name: 'View all' })).toHaveCount(0);
    const completed = page.getByTestId('completed-list');
    await expect(completed.locator(':scope > li')).toHaveCount(5);
    await expect(completed.getByRole('button', { name: '2 earlier updates' })).toHaveCount(2);
    await expect(completed.getByText('Initial review found missing timeline coverage')).toHaveCount(0);
    const panel = page.getByTestId('needs-attention-panel');
    await expect(panel.getByRole('heading')).toHaveText('Needs attention (7)');
    await expect(panel).toContainText('Waiting 50d');
    await expect(panel.getByText('Stale', { exact: true })).toHaveCount(3);
    await expect(panel.getByTestId('work-type-badge')).toHaveCount(0);
    const workflow = page.getByRole('region', { name: 'Usage tips' });
    await expect(workflow).toContainText('For your workflow');
    const statsBox = await page.getByTestId('historical-stats-section').boundingBox();
    expect((await workflow.boundingBox())!.y).toBeGreaterThanOrEqual(statsBox!.y + statsBox!.height);
    const more = panel.getByRole('button', { name: 'Show 4 more' });
    await expect(more).toBeVisible();
    const summary = page.getByTestId('dashboard-summary');
    for (const name of ['Pause automatic summary updates', 'Refresh activity summary'])
      await expect(summary.getByRole('button', { name })).toHaveAttribute('title', name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // Only the dashboard itself: omit unrelated navigation and account data.
    await capture(page, `dashboard-cleanup-${width}`, true);
    const disclosure = completed.getByRole('button', { name: '2 earlier updates' }).first();
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const updates = completed.locator(':scope > li').first().locator('ul');
    await expect(updates.locator('li')).toHaveCount(2);
    for (const [property, value] of Object.entries({ 'border-left-width': '2px', 'border-left-style': 'solid', 'border-left-color': 'rgb(226, 232, 240)', 'padding-left': '12px' }))
      await expect(updates).toHaveCSS(property, value);
    const lineHeights = await updates.locator('a').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    expect(lineHeights.every(height => height <= 28)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await capture(page, `dashboard-updates-expanded-${width}`, true);
    await disclosure.click();
    await expect(updates).toBeHidden();
    await more.click();
    await expect(panel.locator('li')).toHaveCount(7);
    await panel.getByRole('button', { name: 'Show fewer' }).click();
    await expect(panel.locator('li')).toHaveCount(3);
  });

  test(`summary telemetry stays compact with live controls at ${width}px`, async ({ page }) => {
    await fixture(page, { width, height: 900 });
    await respond(page, 'dashboard/narrative', { enabled: true,
      summary: 'Dashboard improvements are being tested, while recent fixes await review.',
    });
    await page.goto('/');
    const summary = page.getByTestId('dashboard-summary');
    await expect(summary.getByText('Live', { exact: true })).toBeVisible();
    await expect(summary).toHaveCSS('height', width < 640 ? '80px' : '40px');
    await expect(summary.locator('p')).toHaveText('Dashboard improvements are being tested, while recent fixes await review.');
    await expect(summary.locator('code')).toHaveCount(0);
    await page.clock.pauseAt(new Date(now + 10_000));
    await page.clock.runFor(4000);
    await expect(summary).toContainText(/Updated \d+s ago/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await captureTarget(summary, `summary-telemetry-live-${width}`);
    await summary.getByRole('button', { name: 'Pause automatic summary updates' }).click();
    await expect(summary.getByText('Paused', { exact: true })).toBeVisible();
    await summary.getByRole('button', { name: 'Refresh activity summary' }).click();
    await expect(summary).toContainText('Updated 0s ago');
    await captureTarget(summary, `summary-telemetry-paused-${width}`);
    await respond(page, 'dashboard/narrative', { enabled: true, summary: 'No work is active, and there are no recent completions.' });
    await summary.getByRole('button', { name: 'Resume automatic summary updates' }).click();
    await summary.getByRole('button', { name: 'Refresh activity summary' }).click();
    await expect(summary.getByText('Idle', { exact: true })).toBeVisible();
    await captureTarget(summary, `summary-telemetry-idle-${width}`);
  });

  const matrixWidth = width === 1440 ? 1920 : width;
  test(`expanded completed events form a chronological matrix at ${matrixWidth}px`, async ({ page }) => {
    await fixture(page, { width: matrixWidth, height: 1000 }, [], []);
    const earlierUpdates = [
      { title: 'Review PR #2467: Repair plan validation', taskType: 'pr-comment', detail: 'Review deferred: awaiting checks on the latest commit', score: null, minutes: 16 },
      { title: 'Followup: Repair plan validation', taskType: 'pr-comment', detail: 'Implemented F4 and F5 delimiter syntax repair · Validation: Lint passed', score: null, minutes: 17 },
      { title: 'Review PR #2467: Repair plan validation', taskType: 'pr-comment', detail: '2 issues found: Allow repairable quotes; Preserve OpenCode attribution', score: 6, minutes: 30 },
      { title: 'Followup: Repair plan validation', taskType: 'pr-comment', detail: 'Lint passed on planValidation.ts:71 (no changes) · Verified: Core package tests', score: null, minutes: 38 },
      { title: 'Repair plan validation', taskType: 'ci', detail: 'CI checks passed', score: null, minutes: 40 },
      { title: 'Ultrafix PR #2467: Repair plan validation', taskType: 'pr-comment', detail: 'Implemented F1–F3 validation task boundaries', score: null, minutes: 45 },
      { title: 'Review PR #2467: Repair plan validation', taskType: 'pr-comment', detail: '3 issues found: Duplicated tasks; Truncated plans', score: 5, minutes: 53 },
    ].map((update, index) => ({ ...outcomes[0], ...update, id: `prior-${index}`, taskId: `prior-${index}`, occurredAt: minutesAgo(update.minutes) }));
    await respond(page, 'dashboard/outcomes', { limit: 50, items: [{ ...outcomes[0], title: 'Review PR #2467: Repair plan validation', detail: '0 issues found', score: 9, earlierUpdates, eventCount: 8 }] });
    await page.goto('/');
    const section = page.getByTestId('completed-section');
    await section.getByRole('button', { name: '7 earlier updates' }).click();
    const updates = section.locator('li ul');
    await expect(updates.getByTestId('work-type-badge')).toHaveText(['Review', 'Fix', 'Review', 'Verify', 'CI', 'Ultrafix', 'Review']);
    await expect(updates.locator('time')).toHaveText(['16m ago', '17m ago', '30m ago', '38m ago', '40m ago', '45m ago', '53m ago']);
    await expect(updates.getByText('Allow repairable quotes & Preserve OpenCode attribution (2 issues)')).toBeVisible();
    await expect(updates).toHaveCSS('border-left-width', '2px');
    const columns = await updates.locator('a').evaluateAll(rows => rows.map(row =>
      Array.from(row.children).map(cell => ({ x: cell.getBoundingClientRect().x, width: cell.getBoundingClientRect().width }))));
    for (const row of columns) {
      expect(row.map(cell => cell.x)).toEqual(columns[0].map(cell => cell.x));
      expect(row).toHaveLength(4);
      expect(row[2].width).toBeGreaterThan(0);
      expect(row[3].width).toBe(48);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(matrixWidth);
    await captureTarget(section, `completed-event-matrix-${matrixWidth}`);
  });

  test(`running goals appear alongside tasks at ${width}px`, async ({ page }) => {
    const goal = { ...running[0], id: 'goal:dashboard-reliability', goalId: 'dashboard-reliability',
      taskId: 'goal-run', taskType: 'goal', repository: 'example/workspace', issueNumber: null,
      title: 'Improve dashboard reliability', state: 'claude_execution', phase: 'Implementing',
      progressLine: 'Checking dashboard tests', activity: 'Running the focused test suite',
      step: { current: 2, total: 4 }, lastActivityAt: minutesAgo(0.1) };
    await fixture(page, { width, height: 900 }, attention, [goal, running[3]]);
    await page.goto('/');
    const section = page.getByTestId('happening-now-section');
    await expect(section.getByTestId('happening-now-list').locator('li')).toHaveCount(2);
    await expect(section.getByTestId('work-type-badge').first()).toHaveText('Goal');
    await expect(section.getByRole('link', { name: /Improve dashboard reliability/ })).toHaveAttribute('href', '/goals/dashboard-reliability');
    await expect(section.getByRole('link', { name: 'View goals' })).toHaveAttribute('href', '/goals?status=running');
    await expect(section.getByTestId('running-step').first()).toHaveText('step 2/4');
    await expect(section).toBeVisible();
    await captureTarget(section, `running-goals-${width}`);
  });
}

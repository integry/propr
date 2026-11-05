import { expect, test, type Locator, type Page } from '@playwright/test';
import { ago, capture, fixture } from './task-list-desktop.fixture';

// A completed PR, on a phone: the implementation that added a file, a follow-up that changed it,
// and a review-only run that scored it. Titles, review text and the added path are long on purpose.
const prNumber = 3120;
const issueNumber = 3115;
const topic = 'Keep the completed review, its findings and every added-file diff readable on a phone-sized browser viewport without clipped controls';
const tag = `[${issueNumber} by Claude Opus 5.5]`;
const addedPath = 'propr-ui/src/components/TaskDetails/reviewFindings/CompletedReviewFindingsSummaryForNarrowViewports.tsx';
const addedName = addedPath.split('/').pop()!;
const implementationRun = `pr-${prNumber}-run-2`;
const followupRun = `pr-${prNumber}-run-1`;
const reviewRun = `pr-${prNumber}-run-0`;

const run = (id: string, title: string, subtitle: string, minutes: number, extra: Record<string, unknown> = {}) => ({
  id, repository: 'integry/propr', repositoryOwner: 'integry', repositoryName: 'propr',
  issueNumber: prNumber, prNumber, linkedIssueNumber: issueNumber, title, subtitle, status: 'completed',
  createdAt: ago(minutes), processedAt: ago(minutes), completedAt: ago(minutes - 6),
  llmProvider: 'claude', model: 'claude-opus-5-5', score: null, commitHash: null, ...extra,
});
const runs = [
  run(reviewRun, `Review PR #${prNumber}: ${tag} ${topic}`, 'Found 2 issues in the narrow review findings layout', 20, { score: 7, commandMode: 'review' }),
  run(followupRun, `Follow-up PR #${prNumber}: ${tag} ${topic}`, 'Wrap long finding paths instead of widening the review card', 45, { commitHash: 'c41d2e7f90ab' }),
  run(implementationRun, `New Issue: ${tag} ${topic}`, 'Add the completed review findings summary component', 90, { commitHash: '7be03a1c55d2' }),
];

// A new file's diff as git writes it: a header, then only additions, enough to scroll.
const addedLines = [
  "import React from 'react';",
  '',
  'export interface ReviewFinding { id: string; severity: \'blocker\' | \'suggestion\'; path: string; summary: string }',
  '',
  '/** Lists a completed review\'s findings; long paths wrap rather than widening the card on a phone. */',
  'export const CompletedReviewFindingsSummaryForNarrowViewports: React.FC<{ findings: ReviewFinding[] }> = ({ findings }) => (',
  '  <ol aria-label="Review findings" className="space-y-2 break-words">',
  ...Array.from({ length: 48 }, (_, index) => `    {/* finding slot ${index + 1}: severity badge, path and summary stay inside the card */}`),
  '    {findings.map(finding => <li key={finding.id}>{finding.severity}: {finding.path} — {finding.summary}</li>)}',
  '  </ol>',
  ');',
  '// END OF ADDED FILE',
];
const addedDiff = [
  `diff --git a/${addedPath} b/${addedPath}`, 'new file mode 100644', 'index 0000000..7be03a1', '--- /dev/null', `+++ b/${addedPath}`,
  `@@ -0,0 +1,${addedLines.length} @@`, ...addedLines.map(line => `+${line}`),
].join('\n');
const followupDiff = [
  `--- a/${addedPath}`, `+++ b/${addedPath}`, '@@ -7,1 +7,1 @@',
  '-  <ol aria-label="Review findings" className="space-y-2">',
  '+  <ol aria-label="Review findings" className="space-y-2 break-words">',
].join('\n');

const reviewText = [
  '## Summary of Changes',
  '',
  `**Review score: 7/10.** The completed review renders on a phone, but two findings remain before PR #${prNumber} can merge.`,
  '',
  `1. **Suggestion** — \`${addedPath}\` keeps the severity badge and the path on one flex row, so a long unbroken path pushes the finding summary off-screen on a 390px viewport instead of wrapping beneath it.`,
  '2. **Suggestion** — The findings list has no empty state; a review that found nothing should say so rather than leave a blank card under the score.',
].join('\n');

const history = (minutes: number, description: string, commandMode?: string) => ({
  history: [
    { state: 'PENDING', timestamp: ago(minutes), metadata: { model: 'claude-opus-5-5' } },
    { state: 'CLAUDE_EXECUTION', timestamp: ago(minutes - 0.2), metadata: { model: 'claude-opus-5-5', description } },
    { state: 'COMPLETED', timestamp: ago(minutes - 6), metadata: { model: 'claude-opus-5-5' } },
  ],
  taskInfo: {
    title: `${commandMode === 'review' ? 'Review' : 'Follow-up'} PR #${prNumber}: ${tag} ${topic}`, subtitle: null,
    type: 'pr-comment', number: prNumber, issueNumber: prNumber, repoOwner: 'integry', repoName: 'propr', modelName: 'claude-opus-5-5', commandMode,
  },
});

async function completedPullRequest(page: Page) {
  await fixture(page);
  await page.route(url => url.pathname === '/api/tasks', route => route.fulfill({ json: { tasks: runs, total: 1, totalRuns: 3 } }));
  await page.route(`**/api/pull-requests/${prNumber}/scores**`, route => route.fulfill({ json: {
    repository: 'integry/propr', pr_number: prNumber, outcome: null, merged_at: null, closed_at: null,
    scores: [{ cycle_number: 1, source: 'review', score: 7, goal: 8, blocker_count: 0, suggestion_count: 2, reviewer_agent: 'claude',
      reviewer_model: 'claude-opus-5-5', implementer_model: 'claude-opus-5-5', head_sha: 'c41d2e7f90ab', task_id: reviewRun, created_at: ago(14) }],
  } }));
  const responses: Record<string, unknown> = {
    [`/api/task/${implementationRun}/history`]: history(90, 'Add the completed review findings summary component'),
    [`/api/task/${implementationRun}/file-changes`]: { taskId: implementationRun, lastUpdated: ago(84),
      files: [{ path: addedPath, linesAdded: addedLines.length, linesRemoved: 0, status: 'added', diff: addedDiff }] },
    [`/api/task/${followupRun}/history`]: history(45, 'Wrap long finding paths instead of widening the review card'),
    [`/api/task/${followupRun}/file-changes`]: { taskId: followupRun, lastUpdated: ago(39),
      files: [{ path: addedPath, linesAdded: 1, linesRemoved: 1, status: 'modified', diff: followupDiff }] },
    [`/api/task/${reviewRun}/history`]: history(20, 'Review the completed findings layout at phone width', 'review'),
    [`/api/task/${reviewRun}/file-changes`]: { taskId: reviewRun, files: [] },
    [`/api/task/${reviewRun}/live-details`]: { todos: [], currentTask: null, events: [
      { id: 'review-thought-1', type: 'thought', timestamp: ago(18), content: `Reading \`${addedPath}\` at a 390px viewport to check how each finding wraps.` },
      { id: 'review-thought-2', type: 'thought', timestamp: ago(15), content: reviewText },
    ] },
  };
  for (const id of [implementationRun, followupRun]) responses[`/api/task/${id}/live-details`] = { events: [], todos: [], currentTask: null };
  await page.route(url => url.pathname in responses, route => route.fulfill({ json: responses[new URL(route.request().url()).pathname] }));
}

/** No horizontal page overflow, and every listed control fully on screen without overlapping the others. */
async function expectPhoneLayout(page: Page, controls: Locator[]) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.getByTestId('task-details').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const boxes = [];
  for (const control of controls) {
    const box = (await control.boundingBox())!;
    expect(box, String(control)).not.toBeNull();
    expect(box.x, String(control)).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, String(control)).toBeLessThanOrEqual(390 + 0.5);
    boxes.push({ control, box });
  }
  for (const [index, { control, box }] of boxes.entries()) {
    for (const other of boxes.slice(index + 1)) {
      const overlaps = box.x < other.box.x + other.box.width - 0.5 && other.box.x < box.x + box.width - 0.5
        && box.y < other.box.y + other.box.height - 0.5 && other.box.y < box.y + box.height - 0.5;
      expect(overlaps, `${control} overlaps ${other.control}`).toBe(false);
    }
  }
}

/** The element at the control's centre is the control itself: nothing is drawn over it. */
const isHitTarget = (control: Locator) => control.evaluate(element => {
  const rect = element.getBoundingClientRect();
  return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
});

test('390px completed PR: inspect the review, then open and close an added file\'s diff from each run', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await completedPullRequest(page);
  await page.goto(`/tasks/${reviewRun}`);

  // 1. The review-only run is the newest: its score and findings read on a phone.
  const timeline = page.getByRole('list', { name: 'Runs' });
  const runRows = timeline.getByTestId('run-timeline-run').locator(':scope > button');
  await expect(runRows).toHaveCount(3);
  await expect(runRows.nth(2)).toHaveAttribute('aria-expanded', 'true');
  await expect(runRows.nth(2).getByTitle('Review score: 7/10')).toBeVisible();
  await expect(page.getByTestId('timeline-run-count')).toHaveText('(3 runs)');
  const summary = page.getByTestId('task-summary');
  await expect(summary).toContainText('Review score: 7/10.');
  await expect(summary).toContainText('The findings list has no empty state');
  await expect(summary.getByText(addedPath).first()).toBeVisible();
  // A review changes no files, so the timeline shows no empty changed-files section.
  await expect(page.getByRole('region', { name: 'Changed files' })).toHaveCount(0);
  const title = page.locator('header').filter({ has: page.getByRole('heading') }).first();
  await expectPhoneLayout(page, [title, page.getByTestId('task-mobile-metadata'), timeline]);
  for (const row of await runRows.all()) expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await summary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await capture(page, 'mobile-review-run-390');
  await summary.scrollIntoViewIfNeeded();
  await expectPhoneLayout(page, [summary]);
  await capture(page, 'mobile-review-findings-390');

  // 2. Back to the implementation run: its added file opens as a full diff, not an empty popup.
  await runRows.nth(0).click();
  await expect(runRows.nth(0)).toHaveAttribute('aria-expanded', 'true');
  await expect(runRows.nth(2)).toHaveAttribute('aria-expanded', 'false');
  const files = page.getByRole('region', { name: 'Changed files' });
  await expect(page.getByText('(Run 1)')).toBeVisible();
  const file = files.getByRole('button', { name: `View diff for ${addedPath}` });
  await expect(file.getByLabel('Added')).toBeVisible();
  await expect(file).toContainText(`+${addedLines.length}`);
  await file.scrollIntoViewIfNeeded();
  await expectPhoneLayout(page, [file]);
  const scroller = page.getByTestId('task-details');
  const pageScroll = await scroller.evaluate(element => element.scrollTop);
  await file.click();

  const dialog = page.getByRole('dialog', { name: addedName });
  const close = dialog.getByRole('button', { name: 'Close diff view' });
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();
  await expect(dialog.getByText('NEW', { exact: true })).toBeVisible();
  // The name wraps in full beside and then beneath the close control, and the path wraps in full under it.
  const path = dialog.getByTestId('diff-file-path');
  await expect(path).toHaveText(addedPath);
  expect(await path.evaluate(element => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().height > 20)).toBe(true);
  await expect(dialog).not.toContainText('No diff content available');
  await expect(dialog).toContainText('new file mode 100644');
  await expect(dialog).toContainText('CompletedReviewFindingsSummaryForNarrowViewports');
  const diff = dialog.locator('[tabindex="0"]');
  const dialogLayout = async () => {
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    await expect(close).toBeInViewport({ ratio: 1 });
    expect(await isHitTarget(close)).toBe(true);
    expect((await close.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    // The title, its status and the counts share the header without covering each other or the close control.
    const heading = dialog.getByText(addedName, { exact: true });
    await expect(heading).toBeInViewport({ ratio: 1 });
    await expectPhoneLayout(page, [heading, diff]);
    await expectPhoneLayout(page, [dialog.getByText('NEW', { exact: true }), path, close, diff]);
    // The name's box runs under the floated close control, so its rendered lines are what must stay clear of it.
    const closeBox = (await close.boundingBox())!;
    for (const line of await heading.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return Array.from(range.getClientRects(), ({ x, y, width, height }) => ({ x, y, width, height }));
    })) {
      expect(line.x + line.width <= closeBox.x || line.y + line.height <= closeBox.y || line.y >= closeBox.y + closeBox.height).toBe(true);
    }
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  };
  await dialogLayout();
  await capture(page, 'mobile-added-file-diff-390');

  // The diff scrolls inside the dialog under real input, down and across its long lines. Input carried on past
  // the diff's ends does not chain to the page behind, and the header and close control stay put.
  const position = () => diff.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft,
    bottom: element.scrollHeight - element.clientHeight, right: element.scrollWidth - element.clientWidth }));
  const start = await position();
  expect(start).toMatchObject({ top: 0, left: 0 });
  expect(start.bottom).toBeGreaterThan(0);
  expect(start.right).toBeGreaterThan(0);
  const diffBox = (await diff.boundingBox())!;
  const centre = { x: diffBox.x + diffBox.width / 2, y: diffBox.y + diffBox.height / 2 };
  // Neither the task's own scroller nor the window behind the popup has moved, and nothing has navigated: full Chromium
  // takes a touch swipe chained past a scroller's edge to the root as a history swipe, which drops the popup.
  const url = page.url();
  await page.evaluate(() => {
    const marked = window as typeof window & { diffPopstates?: number };
    marked.diffPopstates = 0;
    window.addEventListener('popstate', () => { marked.diffPopstates! += 1; });
  });
  const pageStill = async () => {
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => (window as typeof window & { diffPopstates?: number }).diffPopstates)).toBe(0);
    expect(await scroller.evaluate(element => element.scrollTop)).toBe(pageScroll);
    expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
  };
  // Each wheel run carries well past the diff's end, so any surplus that chained would have moved the page.
  await page.mouse.move(centre.x, centre.y);
  for (let step = 0; step < 12; step++) await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await position()).top).toBe(start.bottom);
  for (let step = 0; step < 12; step++) await page.mouse.wheel(400, 0);
  await expect.poll(async () => (await position()).left).toBe(start.right);
  await pageStill();
  // Scrolled across, the diff's dark background still runs under the end of its longest line.
  expect(await diff.evaluate(element =>
    element.querySelector('pre')!.getBoundingClientRect().right >= element.getBoundingClientRect().right - 1)).toBe(true);
  if (browserName === 'chromium') {
    // A finger swiping right brings the start of the lines back, and swiping on past it moves nothing behind.
    // Trusted touch input comes from the Chromium DevTools protocol, so only Chromium covers touch scrolling.
    const touch = await page.context().newCDPSession(page);
    await diff.evaluate(element => element.addEventListener('touchstart', event => {
      if (event.isTrusted) element.dataset.touchStarts = String(Number(element.dataset.touchStarts ?? 0) + 1);
    }, { passive: true }));
    // A swipe's scroll lands after the input events (and a fling carries on after the finger lifts), so it is read only once
    // the diff has stopped moving for ten frames in a row.
    const settled = () => diff.evaluate(element => new Promise<{ top: number; left: number }>(resolve => {
      let last = { top: element.scrollTop, left: element.scrollLeft };
      let still = 0;
      const frame = () => {
        const now = { top: element.scrollTop, left: element.scrollLeft };
        still = now.top === last.top && now.left === last.left ? still + 1 : 0;
        last = now;
        if (still >= 10) resolve(now); else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }));
    const dialogBox = (await dialog.boundingBox())!;
    const closeBox = (await close.boundingBox())!;
    let starts = 0;
    /** One trusted finger swipe from a point on the diff: it lands on the scroll surface, and the popup and page stay put. */
    const swipe = async (from: { x: number; y: number }, dx: number, dy: number) => {
      // The touch starts on the diff itself, not the header or backdrop.
      expect(await diff.evaluate((element, { x, y }) => element.contains(document.elementFromPoint(x, y)), from)).toBe(true);
      const point = (step: number) => ({ touchPoints: [{ x: Math.round(from.x + dx * step / 10), y: Math.round(from.y + dy * step / 10) }] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', ...point(0) });
      for (let step = 1; step <= 10; step++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', ...point(step) });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(diff).toHaveAttribute('data-touch-starts', String(++starts));
      const landed = await settled();
      await expect(dialog).toBeVisible();
      expect(await dialog.boundingBox()).toEqual(dialogBox);
      expect(await close.boundingBox()).toEqual(closeBox);
      await pageStill();
      return landed;
    };
    const near = { x: Math.round(diffBox.x + 20), y: Math.round(centre.y) };
    // Swiping right brings the lines back step by step until they reach the start; the rest start there and carry on past
    // it, the edge full Chromium would otherwise take as a history swipe. The diff stays at its end throughout.
    const lefts = [start.right];
    for (let swipes = 0; swipes < 8; swipes++) {
      const landed = await swipe(near, 300, 0);
      expect(landed.top).toBe(start.bottom);
      lefts.push(landed.left);
    }
    await expect(diff).toHaveAttribute('data-touch-starts', '8');
    for (const [index, left] of lefts.slice(1).entries()) expect(left).toBeLessThanOrEqual(lefts[index]);
    expect(lefts[1]).toBeLessThan(start.right);
    expect(lefts.indexOf(0)).toBeGreaterThan(0);
    expect(lefts.indexOf(0)).toBeLessThan(lefts.length - 1);
    // Touch scrolls the other way too: left across the lines again and back, then up from the end and down to it again.
    const far = { x: near.x + 300, y: near.y };
    const across = await swipe(far, -300, 0);
    expect(across.top).toBe(start.bottom);
    expect(across.left).toBeGreaterThan(0);
    const back = await swipe(near, 300, 0);
    expect(back.top).toBe(start.bottom);
    expect(back.left).toBeLessThan(across.left);
    expect(await swipe(near, 300, 0)).toEqual({ top: start.bottom, left: 0 });
    const high = { x: Math.round(centre.x), y: Math.round(diffBox.y + diffBox.height / 4) };
    const up = await swipe(high, 0, 200);
    expect(up.left).toBe(0);
    expect(up.top).toBeLessThan(start.bottom);
    const low = { x: high.x, y: Math.round(diffBox.y + diffBox.height * 3 / 4) };
    for (let swipes = 0; swipes < 2; swipes++) expect((await swipe(low, 0, -200)).left).toBe(0);
    expect((await position()).top).toBe(start.bottom);
  } else {
    // Other engines bring the start of the lines back with the same real wheel input, carried on past it.
    for (let step = 0; step < 12; step++) await page.mouse.wheel(-400, 0);
  }
  await expect.poll(async () => (await position()).left).toBe(0);
  expect((await position()).top).toBe(start.bottom);
  await expect(dialog.getByText('// END OF ADDED FILE', { exact: false })).toBeInViewport();
  await dialogLayout();
  await pageStill();
  await capture(page, 'mobile-added-file-diff-scrolled-390');

  expect(await page.evaluate(() => document.documentElement.style.overscrollBehavior)).toBe('none');
  await close.click();
  await expect(dialog).toHaveCount(0);
  await expect(file).toBeFocused();
  // Closed, the page's own overscroll (and the browser's history swipe) is back.
  expect(await page.evaluate(() => document.documentElement.style.overscrollBehavior)).toBe('');
  expect(await scroller.evaluate(element => element.scrollTop)).toBe(pageScroll);
  await expectPhoneLayout(page, [file]);
  // A page that sets its own root overscroll gets that value back too, however the popup goes.
  const rootOverscroll = () => page.evaluate(() => document.documentElement.style.overscrollBehavior);
  await page.evaluate(() => { document.documentElement.style.overscrollBehavior = 'auto contain'; });
  // A tap outside the popup closes it too.
  await file.click();
  await expect(dialog).toBeVisible();
  expect(await rootOverscroll()).toBe('none');
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);
  expect(await rootOverscroll()).toBe('auto contain');

  // 3. The follow-up run's change to the same file opens and closes the same way.
  await runRows.nth(1).click();
  await expect(runRows.nth(1)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('(Run 2)')).toBeVisible();
  const changed = files.getByRole('button', { name: `View diff for ${addedPath}` });
  await expect(changed.getByLabel('Added')).toHaveCount(0);
  await changed.click();
  await expect(dialog.getByText('MODIFIED', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('space-y-2 break-words');
  await expect(close).toBeInViewport({ ratio: 1 });
  expect(await isHitTarget(close)).toBe(true);
  expect(await rootOverscroll()).toBe('none');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await rootOverscroll()).toBe('auto contain');
  // Unmounted without closing, by going back to the previous run, it restores the value as well.
  await changed.click();
  await expect(dialog).toBeVisible();
  expect(await rootOverscroll()).toBe('none');
  const followupUrl = page.url();
  await page.goBack();
  await expect.poll(() => page.url()).not.toBe(followupUrl);
  await expect(dialog).toHaveCount(0);
  expect(await rootOverscroll()).toBe('auto contain');
  await expect(runRows.nth(0)).toHaveAttribute('aria-expanded', 'true');

  // 4. And back to the review, whose score and findings are as they were.
  await runRows.nth(2).click();
  await expect(runRows.nth(2)).toHaveAttribute('aria-expanded', 'true');
  await expect(summary).toContainText('two findings remain');
  await expect(page.getByRole('region', { name: 'Changed files' })).toHaveCount(0);
  await expectPhoneLayout(page, [timeline, summary]);
});

/**
 * A short window or a phone in landscape still reaches every changed file, its diff and the task's controls with
 * ordinary scrolling: the task header and pinned bands give way rather than leave the workspace a sliver under them.
 */
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { ago, capture, detailsHistory, fixture, selectedRun, tag } from './task-list-desktop.fixture';

const markdown = Array.from({ length: 121 }, (_, index) => `+Release note line ${index + 1}: withdrawal labels now follow intent.`);

/** A completed run of a pull request with a long two-line title and subtitle and one modified Markdown file. */
async function completedRun(page: Page) {
  await page.route(`**/api/task/${selectedRun}/history`, route => route.fulfill({ json: {
    history: [...detailsHistory, { state: 'COMPLETED', timestamp: ago(0.1), metadata: { model: 'gpt-6-astra', pr: { url: 'https://github.com/integry/propr/pull/2664', number: 2664 } } }],
    taskInfo: {
      title: `Ultrafix PR #2664: ${tag(2659)} Stop work when an issue or PR withdraws intent, including labels removed by a reviewer after the run starts`,
      subtitle: 'Restrict issue-level withdrawal labels to actual intent withdrawal and document the label semantics for repository operators',
      type: 'pr', number: 2664, issueNumber: 2664, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra',
    },
  } }));
  await page.route(`**/api/task/${selectedRun}/file-changes`, route => route.fulfill({ json: {
    taskId: selectedRun, lastUpdated: ago(0.5),
    files: [{ path: 'docs/withdrawal-labels.md', linesAdded: 121, linesRemoved: 0, status: 'modified', diff: `@@ -0,0 +1,121 @@\n${markdown.join('\n')}` }],
  } }));
}

/** The nearest box that scrolls `target`, and the band of it the reader sees between whatever is pinned over its edges. */
const frameOf = (target: Locator) => target.evaluate(element => {
  let frame = element.parentElement;
  while (frame && !(/auto|scroll/.test(getComputedStyle(frame).overflowY) && frame.scrollHeight > frame.clientHeight)) frame = frame.parentElement;
  const owner = frame ?? document.documentElement;
  const box = owner.getBoundingClientRect();
  let top = Math.max(0, box.top);
  let bottom = Math.min(window.innerHeight, box.top + owner.clientHeight);
  // Pinned bands (pane headings, the compact bar, the log bar) cover the frame's edges.
  for (const band of Array.from(owner.querySelectorAll<HTMLElement>('*'))) {
    const position = getComputedStyle(band).position;
    if (position !== 'sticky' && position !== 'fixed') continue;
    const rect = band.getBoundingClientRect();
    if (!rect.height || band.contains(element) || rect.bottom <= top || rect.top >= bottom) continue;
    if (rect.top <= top + 1) top = Math.max(top, rect.bottom);
    else if (rect.bottom >= bottom - 1) bottom = Math.min(bottom, rect.top);
  }
  return { owner: owner.getAttribute('data-testid') ?? owner.tagName, top, bottom, scrollTop: owner.scrollTop };
});

/** The centre of `target`, when that is where a tap or click lands on it rather than on a layer above. */
const hitPoint = (target: Locator) => target.evaluate(element => {
  const box = element.getBoundingClientRect();
  const point = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const hit = document.elementFromPoint(point.x, point.y);
  return hit && element.contains(hit) ? point : null;
});

/**
 * Waits until every scroll offset, and `target`'s box, hold still: momentum and the log's open transition run on.
 * A busy compositor can hold a fling or wheel animation for several frames between steps, so stillness is
 * measured in time, and a scroll that has started counts as running until its `scrollend`.
 */
const settle = (page: Page, target?: Locator) => (target ?? page.locator('body')).evaluate(async element => {
  const QUIET_MS = 300;
  const LIMIT_MS = 5000;
  const geometry = () => {
    const box = element.getBoundingClientRect();
    return `${box.top} ${box.bottom} ${Array.from(document.querySelectorAll('*'), node => node.scrollTop).join()}`;
  };
  let scrolling = false;
  const onScroll = () => { scrolling = true; };
  const onScrollEnd = () => { scrolling = false; };
  document.addEventListener('scroll', onScroll, true);
  document.addEventListener('scrollend', onScrollEnd, true);
  try {
    const start = performance.now();
    let last = geometry();
    let since = start;
    for (;;) {
      await new Promise(requestAnimationFrame);
      const now = geometry();
      const time = performance.now();
      // A scroll whose `scrollend` never comes is done once nothing has moved for the quiet time.
      if (now !== last || (scrolling && time - start < LIMIT_MS)) { last = now; since = time; }
      else if (time - since >= QUIET_MS) return;
    }
  } finally {
    document.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('scrollend', onScrollEnd, true);
  }
});

/** Swipes a finger (or turns the wheel) from the middle of the visible band, as a reader scrolls. */
async function scrollBy(page: Page, cdp: CDPSession | null, frame: { top: number; bottom: number }, deltaY: number) {
  const x = Math.round(page.viewportSize()!.width * 0.3);
  const y = Math.round((frame.top + frame.bottom) / 2);
  if (cdp) {
    const distance = Math.max(-0.45, Math.min(0.45, deltaY / (frame.bottom - frame.top))) * (frame.bottom - frame.top);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 10; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - distance * step / 10 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, deltaY);
  }
  await settle(page);
}

/** Scrolls until `target` shows whole between the pinned bands and a tap at its centre reaches it. */
async function reveal(page: Page, cdp: CDPSession | null, target: Locator) {
  // Each swipe settles the page before the next look.
  await settle(page, target);
  for (let attempt = 0; attempt < 30; attempt++) {
    const [frame, box, point] = await Promise.all([frameOf(target), target.boundingBox(), hitPoint(target)]);
    if (point && box!.y >= frame.top - 1 && box!.y + box!.height <= frame.bottom + 1) return point;
    const middle = (frame.top + frame.bottom) / 2;
    await scrollBy(page, cdp, frame, box!.y + box!.height / 2 - middle);
  }
  throw new Error(`could not scroll ${target} into a tappable spot`);
}

async function press(page: Page, cdp: CDPSession | null, point: { x: number; y: number }) {
  if (cdp) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

/** Turns the wheel until `target` rests whole within a few px above the bottom of the visible band. */
async function restOnBottomEdge(page: Page, target: Locator) {
  await settle(page, target);
  for (let attempt = 0; attempt < 10; attempt++) {
    const [frame, box] = await Promise.all([frameOf(target), target.boundingBox()]);
    const gap = frame.bottom - (box!.y + box!.height);
    if (gap >= 1 && gap <= 6) return;
    await scrollBy(page, null, frame, -Math.round(gap - 3));
  }
  throw new Error(`could not rest ${target} on the bottom edge`);
}

/**
 * Taps or clicks `target` where it rests to open its diff, then closes it: focus returns to the row without moving
 * the reader. The resting position is measured once the swipe's momentum and any capture are done.
 */
async function openAndCloseDiff(page: Page, cdp: CDPSession | null, target: Locator, whileOpen?: () => Promise<void>) {
  await settle(page, target);
  const [frame, at] = await Promise.all([frameOf(target), hitPoint(target)]);
  expect(at).not.toBeNull();
  await press(page, cdp, at!);
  const dialog = page.getByRole('dialog', { name: 'withdrawal-labels.md' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Release note line 1:');
  await whileOpen?.();
  const close = page.getByRole('button', { name: 'Close diff view' });
  const closeAt = await hitPoint(close);
  expect(closeAt).not.toBeNull();
  await press(page, cdp, closeAt!);
  await expect(dialog).toHaveCount(0);
  await expect(target).toBeFocused();
  await settle(page);
  expect(Math.abs((await frameOf(target)).scrollTop - frame.scrollTop)).toBeLessThanOrEqual(1);
  expect(await hitPoint(target)).not.toBeNull();
  return frame;
}

const cases = [
  { name: 'touch landscape 844x390', width: 844, height: 390, touch: true, short: true },
  { name: 'short desktop 880x480', width: 880, height: 480, touch: false, short: true },
  { name: 'portrait 320x640', width: 320, height: 640, touch: true, short: false },
  { name: 'portrait 390x844', width: 390, height: 844, touch: true, short: false },
  { name: 'desktop 1280x820', width: 1280, height: 820, touch: false, short: false },
];

for (const { name, width, height, touch, short } of cases) {
  test(`${name}: changed file, its diff and every task control are reached by scrolling`, async ({ browser }) => {
    // Every swipe waits out its momentum, and a phone-sized flow takes dozens of them.
    test.setTimeout(60_000);
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, baseURL: 'http://127.0.0.1:4173', serviceWorkers: 'block' });
    const page = await context.newPage();
    const cdp = touch ? await context.newCDPSession(page) : null;
    await fixture(page);
    await completedRun(page);
    await page.goto(`/tasks/${selectedRun}`);
    const details = page.getByTestId('task-details');
    const file = page.getByRole('button', { name: 'View diff for docs/withdrawal-labels.md' });
    await expect(file).toBeVisible();
    await expect(page.getByTestId('run-timeline-run')).toHaveCount(8);
    const phone = width < 640;

    // A short task scrolls as one page; a tall one keeps its pinned header over a workspace that scrolls.
    if (short) await expect(details).toHaveAttribute('data-short-workspace', 'true');
    else await expect(details).not.toHaveAttribute('data-short-workspace');
    if (short) await expect(details).toHaveCSS('overflow-y', 'auto');
    if (!phone && !short) {
      await expect(details).toHaveCSS('overflow-y', 'hidden');
      await expect(page.locator('[data-testid="task-details"] > header.sticky')).toHaveCSS('position', 'sticky');
      await expect(page.getByTestId('task-workspace-scroll')).toHaveCSS('overflow-y', 'auto');
    }

    await reveal(page, cdp, file);
    if (short) await capture(page, `task-short-viewport-files-${width}x${height}`);
    const frame = await openAndCloseDiff(page, cdp, file, async () => {
      if (short) await capture(page, `task-short-viewport-diff-${width}x${height}`);
    });
    // A working band, not a sliver between the pinned header, headings and log bar.
    expect(frame.bottom - frame.top).toBeGreaterThanOrEqual(short ? 120 : 200);
    expect(frame.owner).toBe(short || phone ? 'task-details' : 'task-workspace-scroll');
    // Resting whole just above the log bar, the row is not taken for covered when focus returns to it.
    if (short && !touch) {
      await restOnBottomEdge(page, file);
      await openAndCloseDiff(page, cdp, file);
    }

    // The execution log opens and closes from its bar.
    const log = page.locator('button[aria-controls="execution-event-log-content"]');
    await press(page, cdp, await reveal(page, cdp, log));
    await expect(log).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('execution-log-scroll')).toBeVisible();
    // On a phone the open log ends below the fold; a swipe outside it may already fold it away.
    const bar = await reveal(page, cdp, log);
    if (await log.getAttribute('aria-expanded') === 'true') await press(page, cdp, bar);
    await expect(log).toHaveAttribute('aria-expanded', 'false');

    // Back up the page, the header's title, pull request and actions are all there to tap.
    const scope = phone ? page.locator('header.sm\\:hidden') : page.locator('[data-testid="task-details"] > header.sm\\:block');
    await expect(scope.getByText(/including labels removed by a reviewer/)).toBeVisible();
    await reveal(page, cdp, scope.getByText(/Restrict issue-level withdrawal labels/).first());
    const actions = page.getByRole('button', { name: 'More task actions' }).filter({ visible: true }).first();
    await press(page, cdp, await reveal(page, cdp, actions));
    await expect(page.getByRole('menu', { name: 'More task actions' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'More task actions' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await context.close();
  });
}

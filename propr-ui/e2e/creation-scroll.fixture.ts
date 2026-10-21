/**
 * Reader input for the creation shell's scroll frames: where a dialog's action or field shows below its sticky header,
 * and trusted wheel notches and touch drags that scroll it into view, each measured once the page has applied it.
 */
import type { CDPSession, Locator, Page } from '@playwright/test';

/**
 * How far `element` lies inside what the reader sees: every clipping ancestor's client area, below a sticky header
 * it is not part of. Negative `top`/`bottom` is the part cut off at that edge.
 */
export const uncovered = (element: Locator) => element.evaluate(target => {
  let low = 0;
  let high = window.innerHeight;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (getComputedStyle(parent).overflowY === 'visible') continue;
    const box = parent.getBoundingClientRect();
    low = Math.max(low, box.top + parent.clientTop);
    high = Math.min(high, box.top + parent.clientTop + parent.clientHeight);
  }
  const header = target.closest('[role="dialog"]')?.querySelector('header');
  if (header && !header.contains(target) && getComputedStyle(header).position === 'sticky') low = Math.max(low, header.getBoundingClientRect().bottom);
  const box = target.getBoundingClientRect();
  return { top: box.top - low, bottom: high - box.bottom };
});

/**
 * Where a reader's wheel or finger scrolls `target` up (or down) now: in the side gutter of the innermost frame around
 * it that can still scroll that way (the form's body, else the whole pane), within the band of that frame the reader
 * sees below any sticky header, at a point whose hit test lands in that frame (so not on an action footer outside it)
 * and not on a control or a nested scroller. `span` is the height of the band about the point, which a drag must stay within. A late web font
 * or wrap moves these edges, so callers ask again before every notch or drag rather than keep a point that the footer
 * may since have grown over. Null when nothing around `target` can scroll that way, or no point of the band is clear.
 */
export const scrollPoint = (target: Locator, up: boolean) => target.evaluate((element, up) => {
  const scrolls = (frame: Element) => /auto|scroll/.test(getComputedStyle(frame).overflowY)
    && (up ? frame.scrollTop > 0.5 : frame.scrollTop < frame.scrollHeight - frame.clientHeight - 0.5);
  const dialog = element.closest('[role="dialog"]');
  let frame: Element | null = element.parentElement;
  while (frame && !scrolls(frame)) frame = frame === dialog ? null : frame.parentElement;
  if (!frame) return null;
  const scroller = frame;
  const box = frame.getBoundingClientRect();
  let low = Math.max(0, box.top + frame.clientTop);
  let high = Math.min(window.innerHeight, box.top + frame.clientTop + frame.clientHeight);
  for (let parent = frame.parentElement; parent; parent = parent.parentElement) {
    if (getComputedStyle(parent).overflowY === 'visible') continue;
    const clip = parent.getBoundingClientRect();
    low = Math.max(low, clip.top + parent.clientTop);
    high = Math.min(high, clip.top + parent.clientTop + parent.clientHeight);
  }
  const header = dialog?.querySelector('header');
  if (header && getComputedStyle(header).position === 'sticky') low = Math.max(low, header.getBoundingClientRect().bottom);
  const x = Math.round(box.left + frame.clientLeft + 8);
  const clear = (y: number) => {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !scroller.contains(hit) || hit.closest('button, a, input, textarea, select, summary, [tabindex]:not([tabindex="-1"])')) return false;
    for (let between: Element | null = hit; between && between !== scroller; between = between.parentElement) if (scrolls(between)) return false;
    return true;
  };
  // From the middle of the band outwards, keeping two pixels clear of its edges.
  const middle = Math.round((low + high) / 2);
  for (let offset = 0; middle - offset > low + 2 || middle + offset < high - 2; offset += 2) {
    for (const y of [middle - offset, middle + offset]) {
      if (y > low + 2 && y < high - 2 && clear(y)) return { x, y, span: Math.floor(2 * Math.min(y - low, high - y, 100)) - 4 };
    }
  }
  return null;
}, up);

export const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** How long `settled` lets the layout move, outside any wait for a web font, before it fails. */
export const SETTLE_BUDGET_MS = 5000;

/**
 * Waits until the page has applied what the last input set in motion, so a measurement sees what the reader sees: any
 * web font still loading has arrived, and `target`'s box and every scroll offset from it up to the document hold still
 * for two animation frames. Input resolves before its effect: Chromium scrolls a wheel notch on its compositor and the
 * page sees it a frame or more later, WebKit reveals a newly focused field's caret at its next rendering update, and a
 * late font face re-wraps a line. Fails, naming what kept moving, if the layout moves for over five seconds.
 *
 * Font readiness and settling are separate phases. However long a font takes to arrive (a slow network has taken six
 * seconds), that wait is readiness, bounded by the test's own timeout, and not motion: it does not count against the
 * five seconds. Its arrival does change the sample (the font status is part of it), so the layout after it is measured
 * afresh and must again hold still for two frames.
 */
export const settled = (target: Locator) => target.evaluate(async (element, budget) => {
  const geometry = () => {
    const parts: string[] = [document.fonts.status];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const box = node.getBoundingClientRect();
      parts.push(`${node.tagName} ${box.top} ${box.bottom} ${node.scrollTop}/${node.scrollHeight}`);
    }
    return parts.join(' | ');
  };
  // Milliseconds of settling so far, and when the current stretch of it began.
  let spent = 0;
  let since = performance.now();
  let last = geometry();
  for (let still = 0; still < 2;) {
    if (document.fonts.status === 'loading') {
      spent += performance.now() - since;
      await document.fonts.ready;
      since = performance.now();
    }
    await new Promise(requestAnimationFrame);
    const now = geometry();
    still = now === last ? still + 1 : 0;
    if (still < 2 && spent + performance.now() - since > budget) throw new Error(`the page kept moving around ${element.tagName}: ${last} -> ${now}`);
    last = now;
  }
}, SETTLE_BUDGET_MS);

/**
 * One trusted wheel notch with the pointer already in place, returning once the scroll it caused has reached the page
 * (a `scroll` event on any frame) and `target` has settled. A notch that scrolls nothing gives up after two seconds,
 * and the caller measures again.
 */
export async function notch(page: Page, target: Locator, deltaY: number) {
  await page.evaluate(() => {
    (window as unknown as { landed: Promise<boolean> }).landed = new Promise(resolve => {
      const done = (scrolled: boolean) => { document.removeEventListener('scroll', landed, true); clearTimeout(timer); resolve(scrolled); };
      const landed = () => done(true);
      document.addEventListener('scroll', landed, true);
      const timer = setTimeout(() => done(false), 2000);
    });
  });
  await page.mouse.wheel(0, deltaY);
  await page.evaluate(() => (window as unknown as { landed: Promise<boolean> }).landed);
  await settled(target);
}

/**
 * Scrolls with trusted wheel notches over the target's scroll frame until `target` is wholly shown, as a reader would.
 * `moved` runs once the pointer is in place and before its notch, where a late font can re-lay out the pane under it.
 */
export async function wheelToShow(page: Page, target: Locator, moved?: (point: { x: number; y: number }) => Promise<void>) {
  await settled(target);
  for (let step = 0; step < 40; step++) {
    const { top, bottom } = await uncovered(target);
    if (top >= -0.5 && bottom >= -0.5) return;
    // The pointer follows the frame as fonts and wrapping re-lay it out, so a notch never lands on the footer.
    const point = await scrollPoint(target, top < 0);
    if (!point) return;
    await page.mouse.move(point.x, point.y);
    await moved?.(point);
    // Notches up to 40px, finer as the target nears, as a precision wheel or touchpad lands it in a tight gap.
    await notch(page, target, top < 0 ? -Math.min(40, Math.ceil(-top)) : Math.min(40, Math.ceil(-bottom)));
  }
}

/** The same with trusted touch drags past Chromium's 15px touch slop, slow enough not to fling. */
export async function dragToShow(page: Page, touch: CDPSession, target: Locator) {
  await settled(target);
  // Enough short drags to cross a form that enlarged text has made over 1,500px tall.
  for (let step = 0; step < 100; step++) {
    const { top, bottom } = await uncovered(target);
    if (top >= -0.5 && bottom >= -0.5) return;
    const point = await scrollPoint(target, top < 0);
    if (!point) return;
    const { x, y, span } = point;
    const distance = (top < 0 ? 1 : -1) * Math.min(15 + Math.min(Math.ceil(top < 0 ? -top : -bottom) + 1, 30), span);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y - distance / 2 }] });
    for (let move = 1; move <= 8; move++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y - distance / 2 + distance * move / 8) }] });
    await page.waitForTimeout(50);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settled(target);
  }
}

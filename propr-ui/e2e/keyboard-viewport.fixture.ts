/** A stand-in `window.visualViewport` for headless browsers, driven with geometry measured under a real on-screen keyboard. */
import { expect, type CDPSession, type Locator, type Page } from '@playwright/test';

export interface Band { height: number; offsetTop: number }

/**
 * Headless browsers never open an OS keyboard, so `window.visualViewport` is replaced
 * by one the test drives with the measured geometry. Everything else is the production
 * build: its stylesheet, layout and the browser's real `resize`/`scroll` delivery.
 */
export async function installKeyboardViewport(page: Page, layout: { width: number; height: number }) {
  await page.addInitScript(({ width, height }) => {
    const target = new EventTarget();
    const state = { width, height, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 };
    let listeners = 0;
    const viewport = Object.assign(target, {
      addEventListener: (...args: Parameters<EventTarget['addEventListener']>) => { listeners++; EventTarget.prototype.addEventListener.apply(target, args); },
      removeEventListener: (...args: Parameters<EventTarget['removeEventListener']>) => { listeners--; EventTarget.prototype.removeEventListener.apply(target, args); },
    });
    for (const key of Object.keys(state) as Array<keyof typeof state>) Object.defineProperty(viewport, key, { get: () => state[key] });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => viewport });
    Object.assign(window, {
      __keyboard(next: { height: number; offsetTop: number }, events: string[]) {
        Object.assign(state, next, { pageTop: next.offsetTop });
        for (const type of events) target.dispatchEvent(new Event(type));
      },
      __viewportListeners: () => listeners,
      // The ancestors whose overflow clips `element`, as top/bottom spans. A fixed box escapes
      // the clipping of every ancestor up to the one that is its containing block (one with a
      // transform, filter or paint containment), so a fixed modal layer is not cut by the page
      // it was rendered inside.
      __clips(element: Element) {
        const clips: Array<{ top: number; bottom: number }> = [];
        let escaping = getComputedStyle(element).position === 'fixed';
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (escaping && (style.transform !== 'none' || style.perspective !== 'none' || style.filter !== 'none'
            || /paint|layout|strict|content/.test(style.contain) || /transform|perspective|filter/.test(style.willChange))) escaping = false;
          if (!escaping && /(auto|scroll|hidden|clip)/.test(style.overflowY)) {
            const { top, bottom } = parent.getBoundingClientRect();
            clips.push({ top, bottom });
          }
          if (style.position === 'fixed') escaping = true;
        }
        return clips;
      },
    });
  }, layout);
}

/** The page's `window` with `__clips`, for use inside `evaluate` callbacks (which cannot reach this module). */
export type Clipping = { __clips(element: Element): Array<{ top: number; bottom: number }> };

/** Which `visualViewport` events a change delivers: a pan following the caret only scrolls, a keyboard opening or closing does both. */
export type ViewportEvent = 'resize' | 'scroll';

export const setKeyboard = (page: Page, next: Band, events: ViewportEvent[] = ['resize', 'scroll']) =>
  page.evaluate(([value, types]) => (window as unknown as { __keyboard(v: Band, e: ViewportEvent[]): void }).__keyboard(value, types), [next, events] as const);
export const listenerCount = (page: Page) => page.evaluate(() => (window as unknown as { __viewportListeners(): number }).__viewportListeners());

/** Every target lies fully within the visible band `[offsetTop, offsetTop + height]`. */
export async function expectVisible(targets: Locator[], band: Band) {
  for (const target of targets) {
    const box = (await target.boundingBox())!;
    expect(box.y, `${target} starts inside the visible area`).toBeGreaterThanOrEqual(band.offsetTop - 0.5);
    expect(box.y + box.height, `${target} ends inside the visible area`).toBeLessThanOrEqual(band.offsetTop + band.height + 0.5);
  }
}

/**
 * Every target is drawn inside the visible band, not clipped by an ancestor's overflow,
 * and is the element hit at its centre. The hit test alone is not enough: it also
 * reports controls the keyboard's pan has moved above the visible area.
 */
export async function expectShown(targets: Locator[], band: Band) {
  await expectVisible(targets, band);
  for (const target of targets) {
    const shown = await target.evaluate(element => {
      const box = element.getBoundingClientRect();
      for (const clip of (window as unknown as Clipping).__clips(element)) {
        if (box.top < clip.top - 0.5 || box.bottom > clip.bottom + 0.5) return false;
      }
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    });
    expect(shown, `${target} is drawn unclipped and receives a tap at its centre`).toBe(true);
  }
}

/** The focused field shows at least `min` px inside both its scroll areas and the visible band. */
export async function expectFieldVisible(field: Locator, band: Band, min = 72) {
  const shown = await field.evaluate((element, { top, bottom }) => {
    const rect = element.getBoundingClientRect();
    let low = Math.max(rect.top, top); let high = Math.min(rect.bottom, bottom);
    for (const clip of (window as unknown as Clipping).__clips(element)) {
      low = Math.max(low, clip.top); high = Math.min(high, clip.bottom);
    }
    return high - low;
  }, { top: band.offsetTop, bottom: band.offsetTop + band.height });
  expect(shown, 'visible field height').toBeGreaterThanOrEqual(min);
}

/**
 * A scrolling text area shows at least `lines` complete lines: its content box (inside
 * padding), cut to its clipping ancestors and the visible band, is that many line-heights tall.
 */
export async function expectReadableLines(area: Locator, band: Band, lines = 3) {
  const { shown, lineHeight } = await area.evaluate((element, { top, bottom }) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    let low = Math.max(top, box.top + element.clientTop + parseFloat(style.paddingTop));
    let high = Math.min(bottom, box.top + element.clientTop + element.clientHeight - parseFloat(style.paddingBottom));
    for (const clip of (window as unknown as Clipping).__clips(element)) {
      low = Math.max(low, clip.top); high = Math.min(high, clip.bottom);
    }
    return { shown: high - low, lineHeight: parseFloat(style.lineHeight) };
  }, { top: band.offsetTop, bottom: band.offsetTop + band.height });
  expect(shown, `${area} shows ${lines} complete ${lineHeight}px lines`).toBeGreaterThanOrEqual(lines * lineHeight - 0.5);
}

/** The layer's inline frame is gone, so the stylesheet geometry applies again. */
export const expectUnframed = (layer: Locator) => expect(layer).toHaveAttribute('style', /^(?![\s\S]*(top|height|bottom))/);

/** Screenshot of only the visible band, i.e. what the phone shows above the keyboard. */
export async function captureVisible(page: Page, name: string, band: Band) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const { mkdir } = await import('node:fs/promises');
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ path: `../.propr/previews/${name}.png`, animations: 'disabled',
    clip: { x: 0, y: band.offsetTop, width: page.viewportSize()!.width, height: band.height } });
}

/**
 * Scrolls until `target` is drawn wholly inside the band and below `cover` (a header that
 * may stick over the scroll area), then checks it takes a tap at its centre. In Chromium a
 * finger drags at `x` with trusted touch input, as a reader would; Playwright has no trusted
 * touch input for mobile WebKit, so there the browser's own scroll-into-view moves it.
 */
export async function swipeToShow(page: Page, touch: CDPSession | null, target: Locator, band: Band, { x, cover }: { x: number; cover?: Locator }) {
  const head = cover ? await cover.elementHandle() : null;
  const uncovered = () => target.evaluate((element, [head, { offsetTop, height }]) => {
    let low = head && !head.contains(element) ? Math.max(offsetTop, head.getBoundingClientRect().bottom) : offsetTop;
    let high = offsetTop + height;
    const clips = (window as unknown as Clipping).__clips(element);
    for (const clip of clips) {
      low = Math.max(low, clip.top); high = Math.min(high, clip.bottom);
    }
    const box = element.getBoundingClientRect();
    // Where a finger can drag: the outermost scroll area's part of the band (not an inset around it).
    const outer = clips[clips.length - 1];
    const area = { low: Math.max(offsetTop, outer?.top ?? offsetTop), high: Math.min(offsetTop + height, outer?.bottom ?? offsetTop + height) };
    return { top: box.top - low, bottom: high - box.bottom, area };
  }, [head, band] as const);
  if (touch) {
    for (let step = 0; step < 60; step++) {
      const { top, bottom, area } = await uncovered();
      if (top >= -0.5 && bottom >= -0.5) break;
      // A finger moving up reveals what is below. Chromium starts scrolling past its 15px touch
      // slop (a shorter drag is a tap), and a slow drag does not fling; it stays inside the scroll area.
      const distance = (top < 0 ? 1 : -1) * Math.min(15 + Math.ceil(top < 0 ? -top : -bottom) + 1, area.high - area.low - 6);
      const y = (area.low + area.high) / 2;
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: Math.round(y - distance / 2) }] });
      for (let move = 1; move <= 8; move++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y - distance / 2 + distance * move / 8) }] });
      await page.waitForTimeout(50);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      // A drag may leave a short glide; measure once the target has stopped moving.
      await target.evaluate(element => new Promise<void>(resolve => {
        let last = NaN; let still = 0;
        const check = () => {
          const top = element.getBoundingClientRect().top;
          still = top === last ? still + 1 : 0; last = top;
          if (still >= 3) resolve(); else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }));
    }
  } else {
    await target.scrollIntoViewIfNeeded();
  }
  const { top, bottom } = await uncovered();
  expect(top, `${target} starts inside the band${cover ? ', below the header' : ''}`).toBeGreaterThanOrEqual(-0.5);
  expect(bottom, `${target} ends above the keyboard`).toBeGreaterThanOrEqual(-0.5);
  await expectShown([target], band);
}

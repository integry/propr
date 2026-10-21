/**
 * The creation-scroll `settled` helper keeps web font readiness apart from its bounded wait for geometry to hold still.
 * A font held back for longer than the whole settling budget, as the operator's run saw a 6.5s font response, is
 * waited out and the layout it sets is then measured afresh; geometry that keeps moving still fails within the budget,
 * before or after a late font. The font is a local copy of Inter whose delivery the test controls, not the network.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { SETTLE_BUDGET_MS, settled } from './creation-scroll.fixture';

const ORIGIN = 'https://settled.test';
const FONT = readFileSync(new URL('./fonts/inter-var-latin.woff2', import.meta.url));
// A narrow column of large text in the probe font over a monospace fallback, so the font's arrival re-wraps it and
// changes its height, inside a scrolling pane as in the creation shell.
const PAGE = `<!doctype html><style>
  @font-face { font-family: 'Probe'; font-display: swap; src: url(${ORIGIN}/probe.woff2) format('woff2'); }
  #pane { height: 200px; overflow-y: auto; }
  #target { width: 120px; font: 24px 'Probe', monospace; }
</style><div id="pane"><div id="target">Keep every whole action in reach</div></div>`;

/** Opens the probe page with its font held until `release`. */
async function probe(page: Page) {
  let release = () => {};
  const released = new Promise<void>(resolve => { release = resolve; });
  await page.route(`${ORIGIN}/`, route => route.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.route(`${ORIGIN}/probe.woff2`, async route => {
    await released;
    await route.fulfill({ contentType: 'font/woff2', body: FONT }).catch(() => {});
  });
  // A held font can keep the load event from firing, so only the document is waited for.
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => document.fonts.status), 'the probe font is in flight').toBe('loading');
  return { target: page.locator('#target'), release: () => release() };
}

/** Moves `#target` by a pixel every frame: forever, or for `frames` frames once the page's fonts are ready. */
const move = (page: Page, frames = Infinity, afterFonts = false) => page.evaluate(([frames, afterFonts]) => {
  const state = window as unknown as { moved: number; moving: boolean };
  state.moved = 0;
  state.moving = true;
  const target = document.getElementById('target')!;
  const step = () => {
    if (state.moved >= frames) { state.moving = false; return; }
    target.style.marginTop = `${++state.moved % 2}px`;
    requestAnimationFrame(step);
  };
  // The returned promise resolves now; the motion runs on in the page.
  if (afterFonts) void document.fonts.ready.then(() => requestAnimationFrame(step));
  else requestAnimationFrame(step);
}, [frames, afterFonts] as const);

const outcome = (settling: Promise<unknown>) => settling.then(() => 'settled', (error: Error) => error.message);

test.describe('creation-scroll settled', () => {
  test('a font held past the whole settling budget is waited out, and the layout it sets is measured afresh', async ({ page }) => {
    const { target, release } = await probe(page);
    const fallback = (await target.boundingBox())!.height;
    // When the font lands, the page keeps moving for a few more frames, as a re-wrap sets off a scroll or a resize.
    await move(page, 12, true);
    let result: string | undefined;
    const settling = outcome(settled(target)).then(value => { result = value; return value; });
    await page.waitForTimeout(SETTLE_BUDGET_MS + 1500);
    expect(result, 'still waiting for the font, past the budget, without failing').toBeUndefined();
    expect(await page.evaluate(() => document.fonts.status)).toBe('loading');

    release();
    expect(await settling).toBe('settled');
    const state = await page.evaluate(() => { const { moved, moving } = window as unknown as { moved: number; moving: boolean }; return { status: document.fonts.status, moved, moving }; });
    expect(state.status).toBe('loaded');
    expect(state, 'it waited out every frame the arrival set moving').toMatchObject({ moved: 12, moving: false });
    expect((await target.boundingBox())!.height, 'the font re-wrapped the target').not.toBe(fallback);
  });

  test('geometry that keeps moving fails once the budget is spent', async ({ page }) => {
    const { target, release } = await probe(page);
    release();
    await page.evaluate(() => document.fonts.ready);
    await move(page);
    const started = Date.now();
    expect(await outcome(settled(target))).toMatch(/the page kept moving around DIV: /);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(SETTLE_BUDGET_MS);
    expect(elapsed).toBeLessThan(SETTLE_BUDGET_MS + 3000);
  });

  test('a late font does not excuse geometry that keeps moving after it', async ({ page }) => {
    const { target, release } = await probe(page);
    await move(page, Infinity, true);
    const settling = outcome(settled(target));
    await page.waitForTimeout(SETTLE_BUDGET_MS + 1500);
    const arrived = Date.now();
    release();
    expect(await settling).toMatch(/the page kept moving around DIV: loaded \| /);
    const elapsed = Date.now() - arrived;
    expect(elapsed, 'the budget runs from the font arrival').toBeGreaterThanOrEqual(SETTLE_BUDGET_MS - 500);
    expect(elapsed).toBeLessThan(SETTLE_BUDGET_MS + 3000);
  });
});

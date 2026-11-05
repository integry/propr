import { expect, test, type Browser, type Page } from '@playwright/test';
import { HOSTED, proxyHosted, RouteWork } from './pairing-routes.fixture';

// The hosted pairing page, served from the real built UI by the proxy under test.
const HOSTED_PAGE = `${HOSTED}/desktop/pairing?pairing_id=dpr_${'A'.repeat(22)}&tunnel=t-pairing123.propr.dev`;

test.describe('hosted proxy response in flight at teardown', () => {
  /** A hosted navigation whose proxy work is held after `route.fetch`, before its fulfill. */
  async function heldNavigation(browser: Browser, proxy: (page: Page, afterFetch: () => Promise<void>) => Promise<void>) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    let fetched!: () => void;
    let release!: () => void;
    const wasFetched = new Promise<void>(resolve => { fetched = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    await proxy(page, async () => { fetched(); await gate; });
    const navigation = page.goto(HOSTED_PAGE, { waitUntil: 'commit' });
    await wasFetched;
    return { context, navigation, release };
  }

  test('teardown disposes a fetched response the proxy has not fulfilled yet', async ({ browser }) => {
    let fulfilled!: Promise<string>;
    const { context, navigation, release } = await heldNavigation(browser, async (page, afterFetch) => {
      await page.route(`${HOSTED}/**`, async route => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: `http://127.0.0.1:4173${url.pathname}${url.search}` });
        await afterFetch();
        fulfilled = route.fulfill({ response }).then(() => 'fulfilled', (error: Error) => error.message);
      });
    });
    const navigated = navigation.then(() => 'loaded', (error: Error) => error.message);
    // The first step of `context.close()`, taken while the page and its request are still open.
    await context.request.dispose({ reason: 'Test ended.' });
    release();
    await expect.poll(() => fulfilled).toContain('Fetch response has been disposed');
    // The failed fulfill leaves the navigation unanswered until the context closes.
    await context.close();
    expect(await navigated).not.toBe('loaded');
  });

  test('settling fulfills it before teardown and aborts later requests', async ({ browser }) => {
    const work = new RouteWork();
    const { context, navigation, release } = await heldNavigation(browser, (page, afterFetch) => proxyHosted(page, work, { afterFetch }));
    let disposed = false;
    // Settling rethrows a failed fulfill, so the teardown resolving means the response was delivered first.
    const teardown = work.settle().then(async () => {
      await context.request.dispose({ reason: 'Test ended.' });
      disposed = true;
    });
    const waited = await Promise.race([teardown.then(() => 'torn down'), new Promise(resolve => setTimeout(resolve, 250, 'waiting'))]);
    expect(waited, 'teardown waits while the fetched response is unfulfilled').toBe('waiting');
    expect(disposed).toBe(false);
    release();
    await teardown;
    const response = (await navigation)!;
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
    // Requests made after settling are not fetched, so none can outlive the context's responses.
    await expect(context.pages()[0].goto(HOSTED_PAGE)).rejects.toThrow();
    await context.close();
  });
});

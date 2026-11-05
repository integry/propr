import { test as base, type Page, type Route } from '@playwright/test';

export const HOSTED = 'https://app.propr.dev';
/**
 * Route work a test owns. Closing a context first disposes every `route.fetch` response while
 * its page is still open, so a hosted fulfill still in flight would fail. `settle` runs before
 * that teardown, also after a failed assertion: it releases held requests, aborts later ones
 * and waits for the work in flight, rethrowing its failures.
 */
export class RouteWork {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly holds = new Set<() => void>();
  private settling = false;

  hold() {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    this.holds.add(release);
    return { held, release };
  }

  async run(route: Route, handle: () => Promise<void>) {
    const work = this.settling ? route.abort() : handle();
    this.inFlight.add(work);
    try { await work; } finally { this.inFlight.delete(work); }
  }

  async settle() {
    this.settling = true;
    for (const release of this.holds) release();
    while (this.inFlight.size) await Promise.all(this.inFlight);
  }
}

const routeWork = new WeakMap<Page, RouteWork>();
export const routeWorkOf = (page: Page) => routeWork.get(page)!;

export const test = base.extend<{ settleRoutes: void }>({
  // Depends on `page`, so it is torn down before the page's context closes.
  settleRoutes: [async ({ page }, use) => {
    const work = new RouteWork();
    routeWork.set(page, work);
    await use();
    await work.settle();
  }, { auto: true }],
});

/** Serves the real built UI at its hosted origin; API calls remain on the tunnel. */
export async function proxyHosted(page: Page, work: RouteWork, { afterFetch }: { afterFetch?: () => Promise<void> } = {}) {
  await page.route(`${HOSTED}/**`, route => work.run(route, async () => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `http://127.0.0.1:4173${url.pathname}${url.search}` });
    await afterFetch?.();
    await route.fulfill({ response });
  }));
}

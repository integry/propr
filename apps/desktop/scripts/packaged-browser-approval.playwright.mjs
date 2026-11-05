import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createBrowserApproval, focusPairingControlWithKeyboard } from './packaged-browser-approval.mjs';

const createFixture = async () => {
  let approval;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (!approval.handle(request, response, Buffer.concat(chunks).toString())) {
      response.writeHead(404); response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  approval = createBrowserApproval(origin, '/approval');
  return { origin, approval, close: () => new Promise(resolve => server.close(resolve)) };
};

test('canonical browser handoff binds navigation and rejects an old form even after the cookie is replaced', async () => {
  const { chromium } = await import('playwright');
  const fixture = await createFixture();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const stalePage = await context.newPage();
    fixture.approval.reset();
    const handoff = fixture.approval.url();
    assert.equal(new URL(handoff).search, '');
    await stalePage.goto(handoff);
    const staleUrl = stalePage.url();
    assert.equal(new URL(staleUrl).search, '?attempt=1');
    fixture.approval.reset();
    assert.equal(fixture.approval.url(), handoff);
    const currentPage = await context.newPage();
    await currentPage.goto(handoff);
    assert.equal(new URL(currentPage.url()).search, '?attempt=2');
    assert.equal((await context.cookies())[0].value, '2');
    await stalePage.getByRole('button', { name: 'Approve @acceptance-admin', exact: true }).click();
    await stalePage.getByText('Approval unavailable', { exact: true }).waitFor();
    assert.equal(fixture.approval.approved(), false);
    assert.equal((await context.request.get(staleUrl)).status(), 409);
    await currentPage.getByRole('button', { name: 'Approve @acceptance-admin', exact: true }).click();
    await currentPage.getByRole('heading', { name: 'Approval complete' }).waitFor();
    assert.equal(fixture.approval.approved(), true);
    assert.equal((await context.request.post(currentPage.url(), {
      headers: { Origin: fixture.origin }, form: { decision: 'approve' },
    })).status(), 409);
  } finally { if (browser) await browser.close(); await fixture.close(); }
});

test('Playwright opens the fixture-owned approval URL and approves visibly with the keyboard at narrow width and 200% layout zoom', async () => {
  const { chromium } = await import('playwright');
  const fixture = await createFixture();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 880, height: 620 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
    const page = await context.newPage();
    fixture.approval.reset();
    await page.goto(fixture.approval.url());
    assert.equal(fixture.approval.approved(), false);
    // Reproduce the installed login's mouse modality: programmatic focus alone
    // does not activate :focus-visible after a mouse interaction.
    const approve = page.getByRole('button', { name: 'Approve @acceptance-admin', exact: true });
    await approve.evaluate(element => element.addEventListener('click', event => event.preventDefault(), { once: true }));
    await approve.click();
    await approve.focus();
    assert.equal(await approve.evaluate(element => element.matches(':focus-visible')), false);
    for (const zoom of [1, 2]) {
      await page.evaluate(factor => { document.documentElement.style.zoom = String(factor); }, zoom);
      for (const button of await page.getByRole('button').all()) {
        await focusPairingControlWithKeyboard(button);
        const observed = await button.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return { focused: element === document.activeElement, focusVisible: element.matches(':focus-visible'), outline: getComputedStyle(element).outlineStyle, rect: rect.toJSON(), width: innerWidth, height: innerHeight };
        });
        assert.ok(observed.focused && observed.focusVisible && observed.outline !== 'none'
          && observed.rect.left >= -1 && observed.rect.right <= observed.width + 1 && observed.rect.top >= -1 && observed.rect.bottom <= observed.height + 1, JSON.stringify({ zoom, ...observed }));
      }
    }
    // A control below the first viewport at 200% zoom remains reachable by
    // scrolling and keyboard navigation; viewport position alone is not failure.
    await page.evaluate(() => {
      document.body.style.paddingTop = '700px';
      window.scrollTo(0, 0);
    });
    assert.ok(await approve.evaluate(element => element.getBoundingClientRect().top > innerHeight));
    await focusPairingControlWithKeyboard(approve);
    assert.ok(await approve.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return element === document.activeElement && element.matches(':focus-visible')
        && style.outlineStyle !== 'none' && rect.top >= -1 && rect.bottom <= innerHeight + 1;
    }));
    await page.evaluate(() => { document.body.style.paddingTop = ''; });
    // A visible control removed from the tab order must not pass by forcing focus.
    await page.locator('button[value="wrong-account"]').evaluate(element => { element.tabIndex = -1; });
    await assert.rejects(focusPairingControlWithKeyboard(page.locator('button[value="wrong-account"]')), /not keyboard reachable/);
    await page.locator('button[value="wrong-account"]').evaluate(element => { element.removeAttribute('tabindex'); });
    await focusPairingControlWithKeyboard(page.getByRole('button', { name: 'Approve @acceptance-admin', exact: true }));
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Approval complete' }).waitFor();
    assert.equal(fixture.approval.approved(), true);
    for (const [decision, state] of [['reject', 'rejected'], ['expire', 'expired'], ['wrong-account', 'approved']]) {
      fixture.approval.reset();
      await page.goto(fixture.approval.url());
      assert.equal(fixture.approval.approved(), false);
      await focusPairingControlWithKeyboard(page.locator(`button[value="${decision}"]`));
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Approval complete' }).waitFor();
      assert.equal(fixture.approval.status(), state);
      assert.equal(fixture.approval.wrongAccount(), decision === 'wrong-account');
    }
  } finally { if (browser) await browser.close(); await fixture.close(); }
});

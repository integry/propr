import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createBrowserApproval } from './packaged-browser-approval.mjs';

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
    for (const zoom of [1, 2]) {
      await page.evaluate(factor => { document.documentElement.style.zoom = String(factor); }, zoom);
      for (const button of await page.getByRole('button').all()) {
        await button.focus();
        const observed = await button.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return { focused: element === document.activeElement, outline: getComputedStyle(element).outlineStyle, rect: rect.toJSON(), width: innerWidth, height: innerHeight };
        });
        assert.ok(observed.focused && observed.outline !== 'none'
          && observed.rect.left >= -1 && observed.rect.right <= observed.width + 1 && observed.rect.top >= -1 && observed.rect.bottom <= observed.height + 1, JSON.stringify({ zoom, ...observed }));
      }
    }
    await page.getByRole('button', { name: 'Approve @acceptance-admin', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Approval complete' }).waitFor();
    assert.equal(fixture.approval.approved(), true);
    for (const [decision, state] of [['reject', 'rejected'], ['expire', 'expired'], ['wrong-account', 'approved']]) {
      fixture.approval.reset();
      await page.goto(fixture.approval.url());
      assert.equal(fixture.approval.approved(), false);
      await page.locator(`button[value="${decision}"]`).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Approval complete' }).waitFor();
      assert.equal(fixture.approval.status(), state);
      assert.equal(fixture.approval.wrongAccount(), decision === 'wrong-account');
    }
  } finally { if (browser) await browser.close(); await fixture.close(); }
});

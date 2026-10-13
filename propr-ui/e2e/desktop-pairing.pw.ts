import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pairingId = `dpr_${'A'.repeat(22)}`;
const username = 'u'.repeat(39);
const clientName = 'c'.repeat(80);
const tunnel = 'https://t-pairing123.propr.dev';

async function fixture(page: Page, options: { hosted?: boolean; expiresIn?: number; rejectApproval?: 404 | 410 | 409; delayLogout?: boolean; username?: string; clientName?: string } = {}) {
  const fixtureUsername = options.username ?? username;
  const fixtureClientName = options.clientName ?? clientName;
  let loggedOut = false;
  let approvalCount = 0;
  let logoutUrl = '';
  let releaseLogout: (() => void) | undefined;
  const logoutGate = new Promise<void>(resolve => { releaseLogout = resolve; });
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  if (options.hosted) {
    // Serve the real built UI at its hosted origin; API calls remain on the tunnel.
    await page.route('https://app.propr.dev/**', async route => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `http://127.0.0.1:4173${url.pathname}${url.search}` });
      await route.fulfill({ response });
    });
  }
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/logout') {
      logoutUrl = url.href;
      if (options.delayLogout) await logoutGate;
      loggedOut = true;
      return route.fulfill({ status: 200, json: {} });
    }
    if (url.pathname.endsWith('/approve')) {
      approvalCount++;
      return route.fulfill({ status: options.rejectApproval ?? 200, json: options.rejectApproval
        ? options.rejectApproval === 409
          ? { code: 'PAIRING_ALREADY_CONSUMED', error: 'Pairing request was already used' }
          : { code: 'PAIRING_NOT_FOUND', error: 'Pairing request was not found or has expired' }
        : { pairingId, clientName: fixtureClientName, status: 'approved', expiresAt: new Date(Date.now() + 600_000).toISOString() } });
    }
    if (url.pathname.endsWith('/approval')) return route.fulfill({ json: {
      pairingId: url.pathname.split('/').at(-2), clientName: fixtureClientName, status: 'pending', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (options.expiresIn ?? 600_000)).toISOString(),
    } });
    if (url.pathname === '/api/auth/user') return route.fulfill({ status: loggedOut ? 401 : 200, json: loggedOut ? { error: 'Unauthorized' } : {
      id: '101', username: fixtureUsername, login: fixtureUsername, displayName: fixtureUsername, email: null, avatarUrl: null,
      role: 'admin', permissions: [], authorizationSource: 'local',
    } });
    if (url.pathname === '/api/auth/demo-mode') return route.fulfill({ json: { demoMode: false } });
    // A transient compatibility failure is supported by the real App boundary.
    return route.fulfill({ status: 503, json: { error: 'Unavailable in isolated pairing fixture' } });
  });
  await page.goto(options.hosted
    ? `https://app.propr.dev/desktop/pairing?pairing_id=${pairingId}&tunnel=t-pairing123.propr.dev`
    : `/desktop/pairing?pairing_id=${pairingId}`);
  await expect(page.getByRole('button', { name: 'Approve desktop' })).toBeVisible();
  return { approvalCount: () => approvalCount, logoutUrl: () => logoutUrl, releaseLogout: () => releaseLogout!() };
}

async function checkLayout(page: Page, names: string[]) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const name of names) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box!.width, name).toBeGreaterThanOrEqual(44);
    expect(box!.height, name).toBeGreaterThanOrEqual(44);
  }
}

for (const width of [320, 375]) {
  test(`long names and all pairing targets fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const state = await fixture(page);
    await expect(page.getByText(`@${username}`, { exact: true })).toBeVisible();
    await expect(page.getByText(clientName, { exact: true })).toBeVisible();
    await checkLayout(page, ['Approve desktop', 'Cancel', 'Change GitHub account']);
    // Verify the exact breakpoint rather than assuming the responsive class works.
    const approve = await page.getByRole('button', { name: 'Approve desktop' }).boundingBox();
    const cancel = await page.getByRole('button', { name: 'Cancel', exact: true }).boundingBox();
    if (width === 375) expect(approve!.y).toBe(cancel!.y);
    else expect(cancel!.y).toBeGreaterThan(approve!.y);
    const directory = path.resolve('../.propr/previews');
    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, `pairing-${width}.png`), fullPage: true });
    }
    await page.getByRole('button', { name: 'Change GitHub account', exact: true }).click();
    await checkLayout(page, ['Sign out of ProPR and sign in again', 'Keep current account']);
    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      await page.screenshot({ path: path.join(directory, `pairing-change-${width}.png`), fullPage: true });
    }
    await page.getByRole('button', { name: 'Keep current account' }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('Pairing cancelled', { exact: true })).toBeVisible();
    expect(state.approvalCount()).toBe(0);
  });
}

test('hosted logout uses the active API and preserves flow and exact pairing return URL', async ({ page }) => {
  const state = await fixture(page, { hosted: true });
  const flow = new URL(page.url()).searchParams.get('flow');
  expect(flow).toBeTruthy();
  await page.getByRole('button', { name: 'Change GitHub account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out of ProPR and sign in again' }).click();
  await page.waitForURL('https://app.propr.dev/login?**');
  expect(state.logoutUrl()).toBe(`${tunnel}/api/auth/logout`);
  const login = new URL(page.url());
  expect(login.searchParams.get('flow')).toBe(flow);
  const redirect = new URL(login.searchParams.get('redirect_to')!, login.origin);
  expect(redirect.pathname).toBe('/desktop/pairing');
  expect(redirect.searchParams.get('pairing_id')).toBe(pairingId);
  expect(redirect.searchParams.get('flow')).toBe(flow);
  expect(state.approvalCount()).toBe(0);
});

for (const status of [404, 410, 409] as const) {
  test(`approval-time ${status} removes dead actions`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    const state = await fixture(page, { rejectApproval: status });
    await page.getByRole('button', { name: 'Approve desktop' }).click();
    await expect(page.getByRole('alert')).toContainText('expired');
    await expect(page.getByRole('button', { name: 'Approve desktop' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Change GitHub account', exact: true })).toHaveCount(0);
    expect(state.approvalCount()).toBe(1);
    if (process.env.PROPR_CAPTURE_PREVIEWS && status === 404) {
      await page.screenshot({ path: path.resolve('../.propr/previews/pairing-expired.png'), fullPage: true });
      await writeFile(path.resolve('../.propr/previews/manifest.json'), JSON.stringify({ previews: [
        ...[320, 375].flatMap(width => [
          { path: `.propr/previews/pairing-${width}.png`, title: `Pairing at ${width}px`, description: '39-character GitHub username, 80-character unbroken client name and usable approval targets.' },
          { path: `.propr/previews/pairing-change-${width}.png`, title: `Account change at ${width}px`, description: 'Account-switch instructions and both touch targets with long names.' },
        ]),
        { path: '.propr/previews/pairing-expired.png', title: 'Expired pairing', description: 'Approval-time expiry removes approval and account-switch actions at 320px.' },
      ], toolSuggestions: [] }));
    }
  });
}

test('expiry while account change is open removes actions and fences delayed logout navigation', async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page, { expiresIn: 60_000, delayLogout: true });
  await page.getByRole('button', { name: 'Change GitHub account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out of ProPR and sign in again' }).click();
  await expect.poll(state.logoutUrl).toContain('/api/auth/logout');
  await page.clock.fastForward(60_001);
  await expect(page.getByRole('alert')).toContainText('expired');
  const logoutFinished = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout');
  state.releaseLogout();
  await logoutFinished;
  // Let the fetch continuation and React updates finish before checking navigation.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('button', { name: 'Keep current account' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve desktop' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out of ProPR and sign in again' })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/desktop/pairing');
  expect(state.approvalCount()).toBe(0);
});

test('pairing history navigation fences delayed account-switch logout', async ({ page }) => {
  const state = await fixture(page, { delayLogout: true });
  await page.getByRole('button', { name: 'Change GitHub account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out of ProPR and sign in again' }).click();
  await expect.poll(state.logoutUrl).toContain('/api/auth/logout');
  const nextPairingId = `dpr_${'B'.repeat(22)}`;
  const nextApproval = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/${nextPairingId}/approval`));
  // Change the route in the mounted app, leaving the original logout pending.
  await page.evaluate(id => {
    history.pushState(null, '', `/desktop/pairing?pairing_id=${id}`);
    dispatchEvent(new PopStateEvent('popstate'));
  }, nextPairingId);
  await nextApproval;
  await expect(page.getByRole('button', { name: 'Approve desktop' })).toBeVisible();
  await page.getByRole('button', { name: 'Change GitHub account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out of ProPR and sign in again' })).toBeEnabled();

  const logoutFinished = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout');
  state.releaseLogout();
  await logoutFinished;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(new URL(page.url()).pathname).toBe('/desktop/pairing');
  expect(new URL(page.url()).searchParams.get('pairing_id')).toBe(nextPairingId);
  await expect(page.getByRole('button', { name: 'Sign out of ProPR and sign in again' })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(state.approvalCount()).toBe(0);
});

for (const outcome of ['success', 'failure'] as const) {
  for (const newerOperation of [false, true]) {
    test(`history navigation ignores old approval ${outcome} with newer operation ${newerOperation}`, async ({ page }) => {
      await fixture(page, { username: 'pairing-reviewer', clientName: 'Request A · Development desktop' });
      const nextPairingId = `dpr_${'B'.repeat(22)}`;
      await page.route(`**/api/**/${nextPairingId}/approval`, route => route.fulfill({ json: {
        pairingId: nextPairingId, clientName: 'Request B · Development desktop', status: 'pending',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
      } }));
      let releaseOld!: () => void;
      let releaseNew!: () => void;
      const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
      const newGate = new Promise<void>(resolve => { releaseNew = resolve; });
      const submitted: string[] = [];
      await page.route('**/api/**/approve', async route => {
        const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
        submitted.push(id);
        await (id === pairingId ? oldGate : newGate);
        const failed = id === pairingId && outcome === 'failure';
        await route.fulfill({ status: failed ? 410 : 200, json: failed
          ? { code: 'PAIRING_NOT_FOUND', error: 'Pairing request expired' }
          : { pairingId: id, clientName: id, status: 'approved', expiresAt: new Date(Date.now() + 600_000).toISOString() } });
      });
      // Seed B then A in this document's history. Actual back navigation must
      // update the mounted router without losing the held A request.
      await page.evaluate(({ a, b }) => {
        history.pushState(null, '', `/desktop/pairing?pairing_id=${b}`);
        history.pushState(null, '', `/desktop/pairing?pairing_id=${a}`);
        document.documentElement.dataset.pairingHistoryDocument = 'same';
      }, { a: pairingId, b: nextPairingId });
      await page.getByRole('button', { name: 'Approve desktop' }).click();
      await expect.poll(() => submitted).toEqual([pairingId]);
      const loadedB = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/${nextPairingId}/approval`));
      await page.goBack();
      await loadedB;
      await expect(page.getByRole('button', { name: 'Approve desktop' })).toBeEnabled();
      expect(new URL(page.url()).searchParams.get('pairing_id')).toBe(nextPairingId);
      expect(await page.locator('html').getAttribute('data-pairing-history-document')).toBe('same');
      await expect(page.getByText('Request B · Development desktop', { exact: true })).toBeVisible();
      expect(submitted).toEqual([pairingId]);
      if (newerOperation) {
        await page.getByRole('button', { name: 'Approve desktop' }).click();
        await expect.poll(() => submitted).toEqual([pairingId, nextPairingId]);
      }
      const oldFinished = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/${pairingId}/approve`));
      releaseOld();
      await (await oldFinished).finished();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.getByRole('heading', { name: 'Approve desktop access', exact: true })).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByText('Request B · Development desktop', { exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get('pairing_id')).toBe(nextPairingId);
      if (newerOperation) {
        await expect(page.getByRole('button', { name: 'Approving…' })).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
      } else {
        await expect(page.getByRole('button', { name: 'Approve desktop' })).toBeEnabled();
        if (process.env.PROPR_CAPTURE_PREVIEWS && outcome === 'success') {
          const directory = path.resolve('../.propr/previews');
          await mkdir(directory, { recursive: true });
          await page.screenshot({ path: path.join(directory, 'pairing-stale-approval.png'), fullPage: true });
          await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ previews: [{
            path: '.propr/previews/pairing-stale-approval.png', title: 'Replacement request stays pending',
            description: 'Request B remains available for explicit approval after browser Back navigation and release of request A’s delayed successful approval.',
          }], toolSuggestions: [] }));
        }
        await page.getByRole('button', { name: 'Approve desktop' }).click();
        await expect.poll(() => submitted).toEqual([pairingId, nextPairingId]);
      }
      releaseNew();
      await expect(page.getByRole('heading', { name: 'Desktop paired', exact: true })).toBeVisible();
      expect(submitted).toEqual([pairingId, nextPairingId]);
    });
  }
}

test('pending request expires while the approval page stays open', async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page, { expiresIn: 60_000 });
  await page.clock.fastForward(60_001);
  await expect(page.getByRole('alert')).toContainText('expired');
  await expect(page.getByRole('button', { name: 'Approve desktop' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change GitHub account', exact: true })).toHaveCount(0);
  expect(state.approvalCount()).toBe(0);
});

test('successful approval clears expiry feedback after its response crosses the local deadline', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.clock.install();
  await fixture(page, { expiresIn: 60_000, username: 'pairing-reviewer', clientName: 'Development desktop' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let approvalCount = 0;
  await page.route('**/api/**/approve', async route => {
    approvalCount++;
    // The server accepted the request while valid; only delivery is delayed.
    const result = { pairingId, clientName: 'Development desktop', status: 'approved',
      expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await gate;
    await route.fulfill({ json: result });
  });
  await page.getByRole('button', { name: 'Approve desktop' }).click();
  await expect.poll(() => approvalCount).toBe(1);
  await page.clock.fastForward(60_001);
  await expect(page.getByRole('alert')).toContainText('expired');
  await expect(page.getByRole('button', { name: 'Approve desktop' })).toHaveCount(0);
  release();
  await expect(page.getByRole('heading', { name: 'Desktop paired', exact: true })).toBeVisible();
  await expect(page.getByText('Return to the ProPR desktop app.', { exact: false })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve desktop' })).toHaveCount(0);
  expect(approvalCount).toBe(1);
  if (process.env.PROPR_CAPTURE_PREVIEWS) {
    const directory = path.resolve('../.propr/previews');
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, 'pairing-approved-after-expiry.png'), fullPage: true });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ previews: [{
      path: '.propr/previews/pairing-approved-after-expiry.png', title: 'Successful pairing after delayed response',
      description: 'A successful approval delivered after the local deadline shows return-to-Desktop instructions with no obsolete expiry alert.',
    }], toolSuggestions: [] }));
  }
});

test('approval rechecks the deadline when the expiry timer has not run yet', async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page, { expiresIn: 60_000 });
  // Changing wall time without running timers models a suspended/background tab.
  await page.clock.setSystemTime(new Date(Date.now() + 120_000));
  await page.getByRole('button', { name: 'Approve desktop' }).click();
  await expect(page.getByRole('alert')).toContainText('expired');
  await expect(page.getByRole('button', { name: 'Approve desktop' })).toHaveCount(0);
  expect(state.approvalCount()).toBe(0);
});


test('account switching rechecks the deadline before issuing logout', async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page, { expiresIn: 60_000 });
  await page.getByRole('button', { name: 'Change GitHub account', exact: true }).click();
  await page.clock.setSystemTime(new Date(Date.now() + 120_000));
  await page.getByRole('button', { name: 'Sign out of ProPR and sign in again' }).click();
  await expect(page.getByRole('alert')).toContainText('expired');
  await expect(page.getByRole('button', { name: 'Keep current account' })).toHaveCount(0);
  expect(state.logoutUrl()).toBe('');
  expect(state.approvalCount()).toBe(0);
});

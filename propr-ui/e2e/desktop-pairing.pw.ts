import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { blockWebFonts, drawsInter, INTER_URL, serveInter } from './task-logs.fixture';

const pairingId = `dpr_${'A'.repeat(22)}`;
const username = 'u'.repeat(39);
const clientName = 'c'.repeat(80);
const tunnel = 'https://t-pairing123.propr.dev';

async function fixture(page: Page, options: { hosted?: boolean; expiresIn?: number; rejectApproval?: 404 | 410 | 409; delayLogout?: boolean; username?: string; clientName?: string; waitUntil?: 'load' | 'domcontentloaded' } = {}) {
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
    : `/desktop/pairing?pairing_id=${pairingId}`, { waitUntil: options.waitUntil });
  await expect(page.getByRole('button', { name: 'Approve desktop' })).toBeVisible();
  return { approvalCount: () => approvalCount, logoutUrl: () => logoutUrl, releaseLogout: () => releaseLogout!() };
}

/** Each named button's box and the page's horizontal overflow, read in one layout pass. */
async function layoutSnapshot(page: Page, names: string[]) {
  return page.evaluate(names => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    boxes: Object.fromEntries(names.map(name => {
      const matches = [...document.querySelectorAll('button')].filter(button => button.textContent?.trim() === name);
      if (matches.length !== 1) throw new Error(`${matches.length} buttons named ${name}`);
      const { x, y, width, height } = matches[0].getBoundingClientRect();
      return [name, { x, y, width, height }];
    })),
  }), names);
}

async function checkLayout(page: Page, names: string[]) {
  for (const name of names) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  // Read every box from the same frame: a web font arriving between separate reads
  // moves the controls, and comparing positions from two frames proves nothing.
  const layout = await layoutSnapshot(page, names);
  expect(layout.overflow).toBe(false);
  for (const name of names) {
    expect(layout.boxes[name].width, name).toBeGreaterThanOrEqual(44);
    expect(layout.boxes[name].height, name).toBeGreaterThanOrEqual(44);
  }
  return layout.boxes;
}

const pairingActions = ['Approve desktop', 'Cancel', 'Change GitHub account'];

/** Checks identity and targets, and the exact breakpoint: stacked at 320px, one row from 375px. */
async function checkPairing(page: Page, width: number, client = clientName) {
  await expect(page.getByText(`@${username}`, { exact: true })).toBeVisible();
  await expect(page.getByText(client, { exact: true })).toBeVisible();
  const { 'Approve desktop': approve, Cancel: cancel } = await checkLayout(page, pairingActions);
  if (width === 375) expect(cancel.y).toBe(approve.y);
  else expect(cancel.y).toBeGreaterThanOrEqual(approve.y + approve.height);
  return { approve, cancel };
}

// Inter's FontFace status, whether its `loaded` promise has settled yet, and the document's FontFaceSet status.
const interState = (page: Page) => page.evaluate(async () => {
  const inter = [...document.fonts].filter(font => font.family.replace(/["']/g, '') === 'Inter');
  const unsettled = new Promise<string>(resolve => setTimeout(resolve, 0, 'pending'));
  const loaded = await Promise.all(inter.map(font => Promise.race([font.loaded.then(() => 'resolved', () => 'rejected'), unsettled])));
  return { status: inter.map(font => font.status), loaded, set: document.fonts.status };
});
const interReady = { status: ['loaded'], loaded: ['resolved'], set: 'loaded' };

/** Requires the fallback font to be drawn while the held Inter file is still in flight. */
async function expectInterHeld(page: Page, requested: string[], browserName: string) {
  await expect.poll(() => [...requested], { message: 'Inter requested and held' }).toEqual([INTER_URL]);
  // Chromium reports the in-flight face as 'loading'; WebKit reports 'error' once the swap
  // block period ends, but its `loaded` promise stays pending and the set stays 'loading'.
  await expect.poll(() => interState(page), { message: 'Inter in flight' })
    .toEqual({ status: [browserName === 'webkit' ? 'error' : 'loading'], loaded: ['pending'], set: 'loading' });
  expect(await drawsInter(page), 'fallback drawn while Inter is held').toBe(false);
}

/** Requires Inter to have loaded and to be what the page draws, not a fallback. */
async function expectInterDrawn(page: Page) {
  await expect.poll(() => interState(page), { message: 'Inter loaded' }).toEqual(interReady);
  expect(await drawsInter(page), 'Inter drawn').toBe(true);
}

const fontPhases = {
  // Google Fonts unreachable: no Inter face exists and the fallback is drawn.
  'fallback font': async (page: Page) => {
    await blockWebFonts(page);
    const state = await fixture(page);
    await page.evaluate(() => document.fonts.ready);
    expect(await interState(page)).toEqual({ status: [], loaded: [], set: 'loaded' });
    expect(await drawsInter(page), 'fallback drawn').toBe(false);
    return state;
  },
  'loaded Inter': async (page: Page) => {
    await serveInter(page);
    const state = await fixture(page);
    await expectInterDrawn(page);
    return state;
  },
} as const;

for (const [phase, load] of Object.entries(fontPhases)) {
  test.describe(phase, () => {
    for (const width of [320, 375]) {
      test(`long names and all pairing targets fit at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        const state = await load(page);
        await checkPairing(page, width);
        await checkAccountChangeAndCancel(page, width, phase === 'loaded Inter');
        expect(state.approvalCount()).toBe(0);
      });
    }
  });
}

test.describe('Inter held then released', () => {
  for (const width of [320, 375]) {
    test(`long names and all pairing targets fit at ${width}px in both font phases`, async ({ page, browserName }) => {
      await page.setViewportSize({ width, height: 844 });
      const inter = await serveInter(page, { held: true });
      // WebKit holds the load event for a font still downloading.
      const state = await fixture(page, { waitUntil: 'domcontentloaded' });
      await expectInterHeld(page, inter.requested, browserName);
      await checkPairing(page, width);
      inter.release();
      await expectInterDrawn(page);
      await checkPairing(page, width);
      await checkAccountChangeAndCancel(page, width, false);
      expect(state.approvalCount()).toBe(0);
    });
  }

  test('separate reads across the swap disagree at 375px while each frame is aligned', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    const inter = await serveInter(page, { held: true });
    // Inter's proportional 1 is about a fifth narrower than the tabular digits of sans-serif
    // fallbacks (DejaVu and Arial-metric alike), so this name wraps onto more lines until
    // Inter arrives and the swap moves the buttons on any host.
    const digits = '1'.repeat(240);
    await fixture(page, { waitUntil: 'domcontentloaded', clientName: digits });
    await expectInterHeld(page, inter.requested, browserName);
    const fallback = await checkPairing(page, 375, digits);
    // The original measurement: one boundingBox() per button, with the font landing in between.
    const approveRead = await page.getByRole('button', { name: 'Approve desktop' }).boundingBox();
    inter.release();
    await expectInterDrawn(page);
    const cancelRead = await page.getByRole('button', { name: 'Cancel', exact: true }).boundingBox();
    const loaded = await checkPairing(page, 375, digits);
    test.info().annotations.push({ type: 'font swap', description:
      `Approve/Cancel y ${fallback.approve.y}/${fallback.cancel.y} in the fallback font, ${loaded.approve.y}/${loaded.cancel.y} in Inter; separate reads ${approveRead!.y}/${cancelRead!.y}` });
    expect(approveRead!.y).toBe(fallback.approve.y);
    expect(cancelRead!.y).toBe(loaded.cancel.y);
    // The swap moves the row, so comparing reads from the two frames fails although both frames align.
    expect(loaded.approve.y).not.toBe(fallback.approve.y);
    expect(cancelRead!.y).not.toBe(approveRead!.y);
  });
});

async function checkAccountChangeAndCancel(page: Page, width: number, capture: boolean) {
  const directory = path.resolve('../.propr/previews');
  if (capture && process.env.PROPR_CAPTURE_PREVIEWS) {
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, `pairing-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: 'Change GitHub account', exact: true }).click();
  await checkLayout(page, ['Sign out of ProPR and sign in again', 'Keep current account']);
  if (capture && process.env.PROPR_CAPTURE_PREVIEWS) {
    await page.screenshot({ path: path.join(directory, `pairing-change-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: 'Keep current account' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('Pairing cancelled', { exact: true })).toBeVisible();
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

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { Server as SocketIOServer } from 'socket.io';
import { DESKTOP_RENDERER_ORIGIN, PROPR_API_COMPATIBILITY, PROPR_UI_COMPATIBILITY } from '@propr/shared';
import {
  ACCEPTANCE_JOURNEYS,
  ACCEPTANCE_VARIANTS,
  scanAcceptancePaths,
  screenshotName,
  verifyAcceptanceArtifacts,
  writeAcceptanceManifest,
} from './acceptance-artifacts.mjs';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('Packaged desktop visual acceptance must run on Linux x64');
}

const outputDirectory = resolve(process.env.PROPR_DESKTOP_ACCEPTANCE_OUTPUT || 'desktop-acceptance-artifacts');
const binaryPath = resolve('out', 'propr-desktop-linux-x64', 'propr-desktop');
const FIXED_TIME = '2026-01-02T03:04:05.000Z';
const DEVICE_SECRET = 'D'.repeat(43);
const INSTANCE_TOKEN = `propr_it_${'T'.repeat(43)}`;
const ACTIVATION_TICKET = 'A'.repeat(43);
const PAIRING_ID = `dpr_${'P'.repeat(22)}`;
const RECEIPT = 'R'.repeat(22);
const consoleRecords = [];
const requestRecords = [];
const screenshotMetadata = [];
const axeFindings = [];
const surfaces = [];
let keyboardOrder = false;
let visibleFocus = false;
let modalFocusTrap = false;
let modalFocusRestore = false;
let accessibleNames = true;
let liveStatusAnnouncements = false;
let liveErrorAnnouncements = false;
let traceWritten = false;

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(join(outputDirectory, 'screenshots'), { recursive: true, mode: 0o700 });

const json = (response, status, value, extra = {}) => {
  response.writeHead(status, {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, X-ProPR-Desktop-Transport-Scope',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Origin': DESKTOP_RENDERER_ORIGIN,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    ...extra,
  });
  response.end(JSON.stringify(value));
};

const fixtures = [];
const createFixture = async mode => {
  let origin = '';
  let binding = null;
  let authChecks = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { body = {}; }
    requestRecords.push({ mode, method: request.method, url: request.url, hasAuthorization: Boolean(request.headers.authorization) });
    if (request.method === 'OPTIONS') return json(response, 204, {});
    if (request.url === '/api/desktop/discovery') {
      return json(response, 200, {
        product: 'ProPR', version: mode === 'incompatible' ? '99.0.0' : '0.8.15',
        apiCompatibility: mode === 'incompatible' ? 'desktop-incompatible-v99' : PROPR_API_COMPATIBILITY,
        uiCompatibility: PROPR_UI_COMPATIBILITY,
        desktopAuthentication: { protocolVersion: 2, browserPairing: true, instanceBearerTokens: true, socketIoBearerAuthentication: true },
      });
    }
    if (request.method === 'POST' && request.url === '/api/desktop/pairings') {
      binding = body;
      return json(response, 200, {
        pairingId: PAIRING_ID,
        deviceSecret: DEVICE_SECRET,
        approvalUrl: `${origin}/desktop/approve`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        interval: 1,
      });
    }
    if (request.method === 'POST' && request.url === `/api/desktop/pairings/${PAIRING_ID}/poll`) {
      return json(response, 200, {
        status: 'provisional', token: INSTANCE_TOKEN, tokenType: 'Bearer', activationTicket: ACTIVATION_TICKET,
        activationExpiresAt: new Date(Date.now() + 60_000).toISOString(), instanceId: binding?.instanceId,
        origin: binding?.origin, scope: binding?.scope, credentialGeneration: binding?.credentialGeneration,
      });
    }
    if (request.method === 'POST' && request.url === `/api/desktop/pairings/${PAIRING_ID}/activate`) {
      return json(response, 200, { status: 'active', receipt: RECEIPT, activatedAt: FIXED_TIME, expiresAt: null });
    }
    if (request.method === 'POST' && request.url === `/api/desktop/pairings/${PAIRING_ID}/cancel`) {
      return json(response, 200, { status: 'cancelled', cancelledAt: FIXED_TIME });
    }
    if (request.method === 'DELETE' && request.url === '/api/desktop/tokens/current') return json(response, 204, {});
    if (request.url === '/api/auth/user') {
      authChecks += 1;
      if (mode === 'revoked' && authChecks >= 1) return json(response, 401, { code: 'INSTANCE_TOKEN_REVOKED' });
      if (request.headers.authorization !== `Bearer ${INSTANCE_TOKEN}`) return json(response, 401, { code: 'INVALID_INSTANCE_TOKEN' });
      return json(response, 200, {
        id: 'acceptance-user', login: 'acceptance-admin', username: 'acceptance-admin', displayName: 'Acceptance Admin',
        email: null, avatarUrl: null, role: 'admin',
        permissions: ['instance.manage_agents', 'instance.manage_members', 'instance.manage_runtime', 'instance.manage_settings'],
        authorizationSource: 'local',
      });
    }
    if (request.url === '/api/compatibility') return json(response, 200, { apiCompatibility: PROPR_API_COMPATIBILITY, uiCompatibility: PROPR_UI_COMPATIBILITY });
    if (request.url?.startsWith('/api/status')) return json(response, 200, { daemon: 'Running', redis: 'Connected', githubAuth: 'Authenticated', claudeAuth: 'Ready', agents: [], githubEventIntake: 'ProPR Connect', githubEventIntakeStatus: 'Connected' });
    if (request.url?.startsWith('/api/queue/stats')) return json(response, 200, { active: 0, waiting: 0, completed: 12, failed: 0, delayed: 0, paused: 0 });
    if (request.url?.startsWith('/api/stats/generating-plans')) return json(response, 200, { count: 0 });
    if (request.url?.startsWith('/api/stats/')) return json(response, 200, { total: 12, pending: 0, inProgress: 0, completed: 12, failed: 0, dailyCounts: [] });
    if (request.url?.startsWith('/api/tasks')) return json(response, 200, { tasks: [], total: 0 });
    if (request.url?.startsWith('/api/')) return json(response, 200, { agents: [], repositories: [], items: [], count: 0 });
    return json(response, 404, { code: 'NOT_FOUND' });
  });
  const io = new SocketIOServer(server, { path: '/socket.io/', cors: { origin: DESKTOP_RENDERER_ORIGIN, credentials: false } });
  io.use((socket, next) => socket.handshake.headers.authorization === `Bearer ${INSTANCE_TOKEN}` ? next() : next(new Error('INVALID_INSTANCE_TOKEN')));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  fixtures.push({ server, io });
  return origin;
};

const readyOrigin = await createFixture('ready');
const revokedOrigin = await createFixture('revoked');
const incompatibleOrigin = await createFixture('incompatible');

const isolatedEnvironment = (userData, scenario) => {
  const allowed = {};
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'GNOME_KEYRING_CONTROL', 'DISPLAY', 'XAUTHORITY', 'PATH']) {
    if (process.env[name]) allowed[name] = process.env[name];
  }
  return {
    ...allowed,
    HOME: userData,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    XDG_CONFIG_HOME: join(userData, 'xdg-config'),
    XDG_DATA_HOME: join(userData, 'xdg-data'),
    XDG_CACHE_HOME: join(userData, 'xdg-cache'),
    PROPR_DESKTOP_ACCEPTANCE_TEST: '1',
    PROPR_DESKTOP_ACCEPTANCE_SCENARIO: scenario,
  };
};

const launchApplication = async (scenario, initialDeepLink) => {
  const userData = await mkdtemp(join(tmpdir(), 'propr-desktop-acceptance-'));
  const args = [
    '--disable-gpu', '--lang=en-US', '--remote-debugging-port=0', '--propr-acceptance-test', `--user-data-dir=${userData}`,
    '--password-store=gnome-libsecret', ...(initialDeepLink ? [initialDeepLink] : []),
  ];
  const child = spawn(binaryPath, args, { cwd: userData, env: isolatedEnvironment(userData, scenario), stdio: ['ignore', 'pipe', 'pipe'] });
  const childClosed = once(child, 'close');
  let output = '';
  let resolveEndpoint;
  let rejectEndpoint;
  const endpoint = new Promise((resolveValue, rejectValue) => { resolveEndpoint = resolveValue; rejectEndpoint = rejectValue; });
  const capture = chunk => {
    const text = chunk.toString();
    output += text;
    const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) resolveEndpoint(match[1]);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.once('error', rejectEndpoint);
  child.once('close', code => rejectEndpoint(new Error(`Packaged Electron exited before CDP startup (${code ?? 'signal'})`)));
  const timeout = setTimeout(() => rejectEndpoint(new Error('Packaged Electron CDP endpoint did not start')), 20_000);
  const wsEndpoint = await endpoint.finally(() => clearTimeout(timeout));
  const browser = await chromium.connectOverCDP(wsEndpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  page.on('console', message => consoleRecords.push({ type: message.type(), text: message.text().replace(/\s+/g, ' ').slice(0, 500) }));
  await page.waitForFunction(() => Boolean(document.querySelector('.desktop-entry, .desktop-app')), null, { timeout: 15_000 });
  await page.addStyleTag({ content: 'html body, html body button, html body input, html body select, html body textarea { font-family: "Liberation Sans", sans-serif !important; }' });
  if (!await page.evaluate(() => document.fonts.check('12px "Liberation Sans"'))) {
    throw new Error('Deterministic acceptance font is unavailable');
  }
  return {
    browser, context, page, userData,
    async close() {
      await browser.close().catch(() => undefined);
      child.kill('SIGTERM');
      await Promise.race([childClosed, new Promise(resolveValue => setTimeout(resolveValue, 5_000))]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await childClosed;
      }
      await scanAcceptancePaths([userData], [DEVICE_SECRET, INSTANCE_TOKEN, ACTIVATION_TICKET]);
      surfaces.push({ kind: 'process-output', value: output });
      await rm(userData, { recursive: true, force: true });
    },
  };
};

const fillEndpoint = async (page, origin, name = 'Acceptance ProPR') => {
  await page.getByRole('button', { name: /Connect to an existing instance/ }).click();
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Instance URL').fill(origin);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
};

const pair = async (page, origin, name = 'Acceptance ProPR') => {
  await fillEndpoint(page, origin, name);
  await page.getByRole('button', { name: 'Sign in in browser' }).waitFor();
  await page.getByRole('button', { name: 'Sign in in browser' }).click();
};

const inspectAccessibility = async (page, journey) => {
  const result = await new AxeBuilder({ page }).analyze();
  for (const violation of result.violations) {
    if (violation.impact === 'serious' || violation.impact === 'critical') {
      axeFindings.push({ journey, id: violation.id, impact: violation.impact, nodes: violation.nodes.length });
    }
  }
  const unnamed = await page.locator('button, a[href], input, select, textarea').evaluateAll(elements => elements
    .filter(element => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getBoundingClientRect().width > 0;
    })
    .filter(element => {
      const label = element.getAttribute('aria-label') || element.getAttribute('title')
        || (element instanceof HTMLInputElement ? element.labels?.[0]?.textContent : '') || element.textContent;
      return !label?.trim();
    }).length);
  accessibleNames &&= unnamed === 0;
  surfaces.push(await page.evaluate(() => ({
    kind: 'renderer', url: location.href, text: document.body.innerText,
    localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage },
  })));
};

const captureVariants = async (page, journey) => {
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  for (const [variant, config] of Object.entries(ACCEPTANCE_VARIANTS)) {
    await page.emulateMedia({ reducedMotion: config.reducedMotion ? 'reduce' : 'no-preference', colorScheme: 'light' });
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { width: config.viewport.width, height: config.viewport.height, windowState: 'normal' },
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: config.viewport.width, height: config.viewport.height,
      deviceScaleFactor: config.deviceScaleFactor, mobile: false,
    });
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: config.zoom });
    await page.evaluate(() => new Promise(resolveValue => requestAnimationFrame(() => requestAnimationFrame(resolveValue))));
    const name = screenshotName(journey, variant);
    const path = join(outputDirectory, 'screenshots', name);
    await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
    screenshotMetadata.push({
      journey, variant, width: config.viewport.width * config.deviceScaleFactor,
      height: config.viewport.height * config.deviceScaleFactor,
      deviceScaleFactor: config.deviceScaleFactor, zoom: config.zoom, reducedMotion: config.reducedMotion,
    });
  }
  await cdp.detach();
};

const runJourney = async (journey, scenario, initialDeepLink, prepare) => {
  const application = await launchApplication(scenario, initialDeepLink);
  try {
    await prepare(application.page, application);
    await inspectAccessibility(application.page, journey);
    await captureVariants(application.page, journey);
  } finally { await application.close(); }
};

try {
  await runJourney('first-run-chooser', 'default', null, async page => {
    await page.getByRole('heading', { name: 'Let’s set up this computer' }).waitFor();
    const seen = [];
    for (let index = 0; index < 3; index += 1) {
      await page.keyboard.press('Tab');
      seen.push(await page.evaluate(() => document.activeElement?.textContent?.trim() || document.activeElement?.getAttribute('aria-label')));
    }
    keyboardOrder = seen.every(Boolean) && new Set(seen).size === seen.length
      && seen[0].includes('Set up this computer')
      && seen[1].includes('Connect to an existing instance')
      && seen[2].includes('Search for instances on this network');
    visibleFocus = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
    });
  });
  await runJourney('manual-endpoint-confirmation', 'default', null, async page => {
    await page.getByRole('button', { name: /Connect to an existing instance/ }).click();
    await page.getByLabel('Display name').fill('Design Review');
    await page.getByLabel('Instance URL').fill(readyOrigin);
  });
  await runJourney('connect-confirmation', 'default', `propr://connect?api=${encodeURIComponent(readyOrigin)}`, async page => {
    await page.getByText('Review this untrusted instance address').waitFor();
  });
  await runJourney('remote-pairing', 'default', null, async page => {
    await fillEndpoint(page, readyOrigin, 'Remote Team');
    await page.getByRole('button', { name: 'Sign in in browser' }).waitFor();
    liveStatusAnnouncements ||= await page.locator('[aria-live="polite"]').evaluateAll(elements =>
      elements.some(element => Boolean(element.textContent?.trim())));
  });
  await runJourney('local-setup-prerequisites', 'default', null, async page => {
    await page.getByRole('button', { name: /Set up this computer/ }).click();
    await page.getByRole('heading', { name: 'Check the essentials' }).waitFor();
  });
  await runJourney('local-setup-progress', 'default', null, async page => {
    await page.getByRole('button', { name: /Set up this computer/ }).click();
    for (let index = 0; index < 5; index += 1) await page.getByRole('button', { name: /Continue/ }).click();
    await page.getByRole('button', { name: /Install ProPR/ }).click();
    await page.getByRole('heading', { name: 'Setting up ProPR' }).waitFor();
    liveStatusAnnouncements ||= await page.locator('[aria-live="polite"]').evaluateAll(elements =>
      elements.some(element => Boolean(element.textContent?.trim())));
  });
  await runJourney('local-setup-error', 'setup-error', null, async page => {
    await page.getByRole('button', { name: /Set up this computer/ }).click();
    await page.getByRole('heading', { name: 'Setup needs attention' }).waitFor();
  });
  await runJourney('local-setup-completion', 'setup-complete', null, async page => {
    await page.getByRole('button', { name: /Set up this computer/ }).click();
    await page.getByRole('heading', { name: 'ProPR is ready' }).waitFor();
  });
  await runJourney('dashboard-profile-manager', 'default', null, async (page, application) => {
    await pair(page, readyOrigin, 'Operations');
    const opener = page.getByRole('button', { name: /Connected: Operations/ });
    await opener.waitFor({ timeout: 15_000 });
    // Start only after credential-bearing pairing traffic has settled. The
    // resulting trace covers the modal journey without retaining secrets.
    await application.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    await opener.focus();
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Manage instances' });
    await dialog.waitFor();
    const focusables = dialog.locator('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])');
    const focusableCount = await focusables.count();
    if (focusableCount < 2) throw new Error('Acceptance modal has insufficient focus targets');
    await focusables.nth(focusableCount - 1).focus();
    await page.keyboard.press('Tab');
    const wrappedForward = await focusables.first().evaluate(element => element === document.activeElement);
    await focusables.first().focus();
    await page.keyboard.press('Shift+Tab');
    const wrappedBackward = await focusables.nth(focusableCount - 1).evaluate(element => element === document.activeElement);
    modalFocusTrap = wrappedForward && wrappedBackward;
    await page.keyboard.press('Escape');
    modalFocusRestore = await opener.evaluate(element => element === document.activeElement);
    await opener.click();
    await application.context.tracing.stop({ path: join(outputDirectory, 'acceptance-trace.zip') });
    traceWritten = true;
  });
  await runJourney('offline', 'default', null, async page => {
    await fillEndpoint(page, 'http://127.0.0.1:9', 'Offline Lab');
    await page.getByText(/could not discover|could not check|unavailable/i).first().waitFor({ timeout: 15_000 });
    liveErrorAnnouncements ||= await page.locator('[aria-live="polite"], [role="alert"]').evaluateAll(elements =>
      elements.some(element => Boolean(element.textContent?.trim())));
  });
  await runJourney('revoked', 'default', null, async page => {
    await pair(page, revokedOrigin, 'Revoked Lab');
    await page.getByText(/revoked or expired/i).waitFor({ timeout: 15_000 });
  });
  await runJourney('incompatible-instance', 'default', null, async page => {
    await fillEndpoint(page, incompatibleOrigin, 'Future Instance');
    await page.getByText(/Update required/i).waitFor({ timeout: 15_000 });
  });

  if (!traceWritten) throw new Error('Playwright trace was not produced');
  const serious = axeFindings.filter(finding => finding.impact === 'serious').length;
  const critical = axeFindings.filter(finding => finding.impact === 'critical').length;
  const accessibility = {
    schemaVersion: 1, generatedAt: FIXED_TIME, serious, critical, findings: axeFindings,
    keyboardOrder, visibleFocus, modalFocusTrap, modalFocusRestore, accessibleNames,
    liveStatusAnnouncements, liveErrorAnnouncements,
    liveAnnouncements: liveStatusAnnouncements && liveErrorAnnouncements,
    journeys: ACCEPTANCE_JOURNEYS,
  };
  await writeFile(join(outputDirectory, 'accessibility.json'), `${JSON.stringify(accessibility, null, 2)}\n`);
  const sanitizedSummary = {
    schemaVersion: 1, generatedAt: FIXED_TIME, status: 'passed',
    journeys: ACCEPTANCE_JOURNEYS.length, screenshots: screenshotMetadata.length,
    console: { records: consoleRecords.length, errors: consoleRecords.filter(record => record.type === 'error').length },
    services: { httpRequests: requestRecords.length, socketIo: true, pairing: true, connect: true },
    redaction: 'Only counts and allowlisted state are retained; raw logs, URLs, storage, and DOM are scanned then discarded.',
  };
  await writeFile(join(outputDirectory, 'sanitized-summary.json'), `${JSON.stringify(sanitizedSummary, null, 2)}\n`);

  const scanRoot = await mkdtemp(join(tmpdir(), 'propr-acceptance-surfaces-'));
  try {
    surfaces.push({ kind: 'renderer-console', records: consoleRecords });
    surfaces.push({ kind: 'service-urls', records: requestRecords });
    await writeFile(join(scanRoot, 'renderer-and-process-surfaces.json'), JSON.stringify(surfaces));
    await scanAcceptancePaths([scanRoot, outputDirectory], [DEVICE_SECRET, INSTANCE_TOKEN, ACTIVATION_TICKET]);
  } finally { await rm(scanRoot, { recursive: true, force: true }); }
  await writeAcceptanceManifest(outputDirectory, screenshotMetadata);
  await verifyAcceptanceArtifacts(outputDirectory, { sentinels: [DEVICE_SECRET, INSTANCE_TOKEN, ACTIVATION_TICKET] });
  console.log(`Packaged desktop acceptance produced ${screenshotMetadata.length} deterministic screenshots with zero serious/critical findings.`);
} finally {
  for (const fixture of fixtures) {
    await new Promise(resolveValue => fixture.io.close(resolveValue));
    if (fixture.server.listening) await new Promise(resolveValue => fixture.server.close(resolveValue));
  }
}

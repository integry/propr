import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { Server as SocketIOServer } from 'socket.io';
import { DESKTOP_RENDERER_ORIGIN, PROPR_API_COMPATIBILITY, PROPR_UI_COMPATIBILITY } from '@propr/shared';
import {
  ACCEPTANCE_JOURNEYS,
  ACCEPTANCE_PROFILE_PREFIX,
  ACCEPTANCE_SURFACES_PREFIX,
  ACCEPTANCE_VARIANTS,
  DETERMINISTIC_INPUTS,
  FIXED_ACCEPTANCE_ORIGINS,
  FIXED_TIME,
  defaultAcceptanceOutputDirectory,
  prepareAcceptanceArtifactDirectory,
  readPngDimensions,
  safeRemoveAcceptanceLeaf,
  scanAcceptancePaths,
  screenshotName,
  verifyAcceptanceArtifacts,
  writeAcceptanceManifest,
} from './acceptance-artifacts.mjs';
import {
  captureElectronRendererScreenshot,
  forEachElectronRendererVariant,
  waitForUsableElectronRenderer,
} from './packaged-acceptance-renderer.mjs';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('Packaged desktop visual acceptance must run on Linux x64');
}

const outputDirectory = resolve(process.env.PROPR_DESKTOP_ACCEPTANCE_OUTPUT || defaultAcceptanceOutputDirectory());
const binaryPath = resolve('out', 'propr-desktop-linux-x64', 'propr-desktop');
const DEVICE_SECRET = 'D'.repeat(43);
const INSTANCE_TOKEN = `propr_it_${'T'.repeat(43)}`;
const ACTIVATION_TICKET = 'A'.repeat(43);
const PAIRING_ID = `dpr_${'P'.repeat(22)}`;
const RECEIPT = 'R'.repeat(22);
const SENTINELS = [DEVICE_SECRET, INSTANCE_TOKEN, ACTIVATION_TICKET];
const FIXED_MILLIS = Date.parse(FIXED_TIME);
const consoleRecords = [];
const pendingConsoleRecords = [];
const pageErrorRecords = [];
const processRecords = [];
const requestRecords = [];
const socketRecords = [];
const screenshotMetadata = [];
const accessibilityChecks = [];
const axeFindings = [];
const liveAnnouncements = {};
const surfaces = [];
const boundaryJourneys = new Set();
let activeJourney = 'startup';
let keyboardOrder = false;
let visibleFocus = false;
let modalFocusTrap = false;
let modalFocusRestore = false;
let traceWritten = false;

const digest = value => createHash('sha256').update(value).digest('hex');
const unique = values => [...new Set(values)].sort((a, b) => ACCEPTANCE_JOURNEYS.indexOf(a) - ACCEPTANCE_JOURNEYS.indexOf(b));
const sleep = milliseconds => new Promise(resolveValue => setTimeout(resolveValue, milliseconds));

await access(binaryPath, fsConstants.X_OK);
const binaryStats = await lstat(binaryPath);
if (!binaryStats.isFile() || binaryStats.isSymbolicLink()) throw new Error('Packaged acceptance binary must be an executable non-link file');
await prepareAcceptanceArtifactDirectory(outputDirectory);

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
const createFixture = async (mode, fixedOrigin) => {
  const expectedUrl = new URL(fixedOrigin);
  let binding = null;
  let authChecks = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { body = {}; }
    requestRecords.push({
      journey: activeJourney,
      mode,
      method: request.method || '',
      url: request.url || '',
      fullUrl: `${fixedOrigin}${request.url || ''}`,
      origin: request.headers.origin || '',
      hasAuthorization: Boolean(request.headers.authorization),
      bodyBytes: Buffer.byteLength(bodyText),
    });
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
        approvalUrl: `${fixedOrigin}/api/desktop/pairings/${PAIRING_ID}/browser`,
        expiresAt: new Date(FIXED_MILLIS + 60_000).toISOString(),
        interval: 1,
      });
    }
    if (request.method === 'POST' && request.url === `/api/desktop/pairings/${PAIRING_ID}/poll`) {
      return json(response, 200, {
        status: 'provisional', token: INSTANCE_TOKEN, tokenType: 'Bearer', activationTicket: ACTIVATION_TICKET,
        activationExpiresAt: new Date(FIXED_MILLIS + 60_000).toISOString(), instanceId: binding?.instanceId,
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
  io.on('connection', socket => {
    const journey = activeJourney;
    socketRecords.push({ journey, mode, event: 'connection', authenticated: socket.handshake.headers.authorization === `Bearer ${INSTANCE_TOKEN}` });
    socket.onAny(event => socketRecords.push({ journey, mode, event, authenticated: true }));
  });
  server.listen(Number(expectedUrl.port), expectedUrl.hostname);
  await Promise.race([
    once(server, 'listening'),
    once(server, 'error').then(([error]) => { throw error; }),
  ]);
  const address = server.address();
  fixtures.push({ server, io });
  const observedOrigin = `http://${address.address}:${address.port}`;
  if (observedOrigin !== fixedOrigin) throw new Error(`Acceptance fixture origin changed: ${observedOrigin}`);
  return fixedOrigin;
};

let readyOrigin;
let revokedOrigin;
let incompatibleOrigin;

const isolatedEnvironment = (userData, scenario) => {
  const allowed = {};
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'GNOME_KEYRING_CONTROL', 'DISPLAY', 'XAUTHORITY', 'PATH']) {
    if (process.env[name]) allowed[name] = process.env[name];
  }
  return {
    ...allowed,
    HOME: userData,
    LANG: 'C.UTF-8',
    LANGUAGE: 'en_US:en',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    SOURCE_DATE_EPOCH: String(Math.floor(FIXED_MILLIS / 1000)),
    XDG_CONFIG_HOME: join(userData, 'xdg-config'),
    XDG_DATA_HOME: join(userData, 'xdg-data'),
    XDG_CACHE_HOME: join(userData, 'xdg-cache'),
    PROPR_DESKTOP_ACCEPTANCE_TEST: '1',
    PROPR_DESKTOP_ACCEPTANCE_SCENARIO: scenario,
  };
};

const terminateProcessTree = async (child, childClosed) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!Number.isInteger(child.pid)) { await childClosed.catch(() => undefined); return; }
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  await Promise.race([childClosed, sleep(5_000)]).catch(() => undefined);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    await childClosed.catch(() => undefined);
  }
};

const launchApplication = async (scenario, initialDeepLink) => {
  const userData = await mkdtemp(join(tmpdir(), ACCEPTANCE_PROFILE_PREFIX));
  let child;
  let childClosed;
  let browser;
  let cleaned = false;
  let output = '';
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const failures = [];
    if (browser) await browser.close().catch(error => failures.push(error));
    if (child && childClosed) await terminateProcessTree(child, childClosed).catch(error => failures.push(error));
    await scanAcceptancePaths([userData], SENTINELS).catch(error => failures.push(error));
    surfaces.push({ kind: 'packaged-process-output', journey: activeJourney, value: output });
    processRecords.push({ journey: activeJourney, source: 'packaged-process', level: 'combined', bytes: Buffer.byteLength(output), sha256: digest(output) });
    await safeRemoveAcceptanceLeaf(userData, { kind: 'profile' }).catch(error => failures.push(error));
    if (failures.length) throw new AggregateError(failures, 'Packaged acceptance cleanup failed');
  };

  try {
    const args = [
      '--disable-background-networking', '--disable-gpu', '--force-device-scale-factor=1', '--lang=en-US',
      '--remote-debugging-port=0', '--propr-acceptance-test', `--user-data-dir=${userData}`,
      '--password-store=gnome-libsecret', ...(initialDeepLink ? [initialDeepLink] : []),
    ];
    child = spawn(binaryPath, args, {
      cwd: userData,
      detached: true,
      env: isolatedEnvironment(userData, scenario),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    childClosed = once(child, 'close');
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
    browser = await chromium.connectOverCDP(wsEndpoint);
    const { context, page } = await waitForUsableElectronRenderer(browser, child, {
      expectedUrlPrefix: DESKTOP_RENDERER_ORIGIN,
      timeoutMs: 15_000,
    });
    page.on('console', message => {
      const journey = activeJourney;
      const pending = Promise.all(message.args().map(async argument => {
        try { return await argument.jsonValue(); } catch { return { unserializable: argument.toString() }; }
      })).then(argumentsValue => consoleRecords.push({
        journey,
        type: message.type(),
        text: message.text(),
        arguments: argumentsValue,
        location: message.location(),
      }));
      pendingConsoleRecords.push(pending);
    });
    page.on('pageerror', error => pageErrorRecords.push({ journey: activeJourney, name: error.name, message: error.message, stack: error.stack || '' }));
    await page.evaluate(({ fixedTime, fixedMillis }) => {
      const NativeDate = Date;
      class AcceptanceDate extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [fixedMillis])); }
        static now() { return fixedMillis; }
      }
      Object.defineProperty(window, 'Date', { configurable: false, value: AcceptanceDate });
      let uuidCounter = 0;
      Object.defineProperty(Crypto.prototype, 'randomUUID', {
        configurable: false,
        value: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
      });
      document.documentElement.dataset.acceptanceFixedTime = fixedTime;
    }, { fixedTime: FIXED_TIME, fixedMillis: FIXED_MILLIS });
    await page.waitForFunction(() => Boolean(document.querySelector('.desktop-entry, .desktop-app')), null, { timeout: 15_000 });
    await page.addStyleTag({ content: `
      *, *::before, *::after { animation: none !important; caret-color: transparent !important; transition: none !important; scroll-behavior: auto !important; }
      html body, html body button, html body input, html body select, html body textarea { font-family: "Liberation Sans", sans-serif !important; }
    ` });
    const initialization = await page.evaluate(fixedTime => ({
      rendererOrigin: `${location.protocol}//${location.host}`,
      preloadBridge: typeof window.proprDesktop === 'object' && window.proprDesktop !== null
        && typeof window.__PROPR_DESKTOP__ === 'object' && window.__PROPR_DESKTOP__ !== null,
      fontLoaded: document.fonts.check('12px "Liberation Sans"'),
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      rendererTime: new Date().toISOString(),
      fixedMarker: document.documentElement.dataset.acceptanceFixedTime === fixedTime,
    }), FIXED_TIME);
    if (initialization.rendererOrigin !== 'propr-app://renderer' || !initialization.preloadBridge
      || !initialization.fontLoaded || initialization.locale !== DETERMINISTIC_INPUTS.locale
      || initialization.timezone !== DETERMINISTIC_INPUTS.timezone || initialization.rendererTime !== FIXED_TIME
      || !initialization.fixedMarker) {
      throw new Error(`Packaged acceptance deterministic boundary initialization failed: ${JSON.stringify(initialization)}`);
    }
    boundaryJourneys.add(activeJourney);
    return { context, page, close: cleanup };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Packaged acceptance launch and cleanup failed');
    }
    throw error;
  }
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

const liveRegionSnapshot = () => [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')].map(element => ({
  ariaLive: element.getAttribute('aria-live') || '',
  role: element.getAttribute('role') || '',
  text: element.textContent || '',
}));

const observeLiveMutation = async (page, kind, journey, action) => {
  const before = await page.evaluate(liveRegionSnapshot);
  await action();
  await page.waitForFunction(({ beforeJson, kindName }) => {
    const snapshot = [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')].map(element => ({
      ariaLive: element.getAttribute('aria-live') || '', role: element.getAttribute('role') || '', text: element.textContent || '',
    }));
    const changed = JSON.stringify(snapshot) !== beforeJson && snapshot.some(entry => entry.text.trim());
    if (!changed) return false;
    return kindName === 'status' || snapshot.some(entry => entry.role === 'alert' || /could not|unavailable|error|attention/i.test(entry.text));
  }, { beforeJson: JSON.stringify(before), kindName: kind }, { timeout: 15_000 });
  const after = await page.evaluate(liveRegionSnapshot);
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  if (beforeJson === afterJson) throw new Error(`Acceptance ${kind} live region did not mutate`);
  liveAnnouncements[kind] = { journey, beforeHash: digest(beforeJson), afterHash: digest(afterJson), mutated: true };
};

const collectRendererSurface = async (page, journey, name) => {
  const renderer = await page.evaluate(async ({ journeyName, screenshot }) => {
    const attributes = element => Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value]));
    const forms = [...document.querySelectorAll('input, select, textarea, button')].map(element => ({
      tagName: element.tagName,
      attributes: attributes(element),
      value: 'value' in element ? element.value : '',
      checked: 'checked' in element ? element.checked : false,
      selectedValues: element instanceof HTMLSelectElement ? [...element.selectedOptions].map(option => option.value) : [],
    }));
    const databases = [];
    if (typeof indexedDB.databases === 'function') {
      for (const databaseInfo of await indexedDB.databases()) {
        if (!databaseInfo.name) continue;
        const contents = await new Promise((resolveValue, rejectValue) => {
          const request = indexedDB.open(databaseInfo.name);
          request.onerror = () => rejectValue(request.error);
          request.onsuccess = () => {
            const database = request.result;
            const stores = [...database.objectStoreNames];
            if (stores.length === 0) { database.close(); resolveValue({ name: databaseInfo.name, version: database.version, stores: {} }); return; }
            const transaction = database.transaction(stores, 'readonly');
            const values = {};
            transaction.onerror = () => rejectValue(transaction.error);
            transaction.oncomplete = () => { database.close(); resolveValue({ name: databaseInfo.name, version: database.version, stores: values }); };
            stores.forEach(store => {
              const all = transaction.objectStore(store).getAll();
              all.onsuccess = () => { values[store] = all.result; };
            });
          };
        });
        databases.push(contents);
      }
    }
    const cachesData = [];
    if ('caches' in window) {
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        const entries = [];
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          entries.push({ requestUrl: request.url, responseUrl: response?.url || '', body: response ? await response.clone().text() : '' });
        }
        cachesData.push({ name: cacheName, entries });
      }
    }
    return {
      kind: 'renderer', journey: journeyName, screenshot, url: location.href, title: document.title,
      html: document.documentElement.outerHTML, forms,
      localStorage: Object.fromEntries(Object.entries(localStorage)),
      sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
      indexedDB: databases, caches: cachesData,
    };
  }, { journeyName: journey, screenshot: name });
  renderer.cookies = await page.context().cookies();
  surfaces.push(renderer);
};

const inspectAccessibility = async (page, journey, variant, config, metrics, name) => {
  const result = await new AxeBuilder({ page }).analyze();
  const seriousFindings = result.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical');
  for (const violation of seriousFindings) {
    axeFindings.push({ name, journey, variant, id: violation.id, impact: violation.impact, nodes: violation.nodes.length });
  }
  const deterministic = await page.evaluate(({ expectedReducedMotion, fixedTime }) => {
    const visibleControls = [...document.querySelectorAll('button, a[href], input, select, textarea')].filter(element => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
    });
    const unnamed = visibleControls.filter(element => {
      const label = element.getAttribute('aria-label') || element.getAttribute('title')
        || (element instanceof HTMLInputElement ? element.labels?.[0]?.textContent : '') || element.textContent;
      return !label?.trim();
    }).length;
    return {
      accessibleNames: unnamed === 0,
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      fontLoaded: document.fonts.check('12px "Liberation Sans"'),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      rendererTime: new Date().toISOString(),
      animationsDisabled: document.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'),
      expectedReducedMotion,
    };
  }, { expectedReducedMotion: config.reducedMotion, fixedTime: FIXED_TIME });
  if (deterministic.locale !== DETERMINISTIC_INPUTS.locale || deterministic.timezone !== DETERMINISTIC_INPUTS.timezone
    || deterministic.rendererTime !== FIXED_TIME || deterministic.reducedMotion !== config.reducedMotion
    || deterministic.reducedMotion !== deterministic.expectedReducedMotion || !deterministic.fontLoaded
    || !deterministic.animationsDisabled) {
    throw new Error(`Acceptance deterministic renderer inputs changed for ${name}: ${JSON.stringify(deterministic)}`);
  }
  accessibilityChecks.push({
    name, journey, variant,
    serious: seriousFindings.filter(finding => finding.impact === 'serious').length,
    critical: seriousFindings.filter(finding => finding.impact === 'critical').length,
    accessibleNames: deterministic.accessibleNames,
    locale: deterministic.locale,
    timezone: deterministic.timezone,
    fontLoaded: deterministic.fontLoaded,
    reducedMotion: deterministic.reducedMotion,
    viewport: metrics.viewport,
    deviceScaleFactor: metrics.deviceScaleFactor,
    zoom: metrics.zoom,
    animationsDisabled: deterministic.animationsDisabled,
    rendererTime: deterministic.rendererTime,
  });
};

const captureVariants = async (page, journey) => {
  const cdp = await page.context().newCDPSession(page);
  try {
    await forEachElectronRendererVariant(page, cdp, ACCEPTANCE_VARIANTS, async ({ variant, config, metrics }) => {
      const name = screenshotName(journey, variant);
      await inspectAccessibility(page, journey, variant, config, metrics, name);
      await collectRendererSurface(page, journey, name);
      const first = await captureElectronRendererScreenshot(cdp);
      const second = await captureElectronRendererScreenshot(cdp);
      const firstDigest = digest(first);
      if (!first.equals(second)) throw new Error(`Acceptance screenshot was not repeatable for ${name}`);
      const dimensions = readPngDimensions(first);
      const expectedDimensions = {
        width: metrics.viewport.width * metrics.deviceScaleFactor,
        height: metrics.viewport.height * metrics.deviceScaleFactor,
      };
      if (dimensions.width !== expectedDimensions.width || dimensions.height !== expectedDimensions.height) {
        throw new Error(`Acceptance screenshot dimensions changed for ${name}: ${JSON.stringify(dimensions)}`);
      }
      await writeFile(join(outputDirectory, 'screenshots', name), first, { mode: 0o600 });
      screenshotMetadata.push({
        name, journey, variant,
        width: dimensions.width,
        height: dimensions.height,
        deviceScaleFactor: metrics.deviceScaleFactor,
        zoom: metrics.zoom,
        reducedMotion: metrics.reducedMotion,
        locale: DETERMINISTIC_INPUTS.locale,
        timezone: DETERMINISTIC_INPUTS.timezone,
        font: DETERMINISTIC_INPUTS.font,
        colorScheme: DETERMINISTIC_INPUTS.colorScheme,
        rendererTime: FIXED_TIME,
        originPolicy: DETERMINISTIC_INPUTS.originPolicy,
        visibleData: DETERMINISTIC_INPUTS.visibleData,
        animations: DETERMINISTIC_INPUTS.animations,
        repeatabilitySha256: firstDigest,
      });
    }, { colorScheme: DETERMINISTIC_INPUTS.colorScheme });
  } finally {
    await cdp.detach();
  }
};

const runJourney = async (journey, scenario, initialDeepLink, prepare) => {
  activeJourney = journey;
  const application = await launchApplication(scenario, initialDeepLink);
  try {
    const afterCapture = await prepare(application.page, application);
    await captureVariants(application.page, journey);
    if (typeof afterCapture === 'function') await afterCapture();
  } finally {
    await application.close();
  }
};

const waitForObserved = async (predicate, description) => {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Acceptance did not observe ${description}`);
    await sleep(50);
  }
};

const observedServiceSummary = () => {
  const restRequests = requestRecords.filter(record => record.method !== 'OPTIONS' && record.url.startsWith('/api/'));
  const authenticatedRequests = restRequests.filter(record => record.hasAuthorization);
  const socketConnections = socketRecords.filter(record => record.event === 'connection' && record.authenticated);
  const socketEvents = socketRecords.filter(record => record.event !== 'connection');
  const pairingStarted = requestRecords.filter(record => record.method === 'POST' && record.url === '/api/desktop/pairings');
  const pairingPolled = requestRecords.filter(record => record.method === 'POST' && record.url === `/api/desktop/pairings/${PAIRING_ID}/poll`);
  const pairingActivated = requestRecords.filter(record => record.method === 'POST' && record.url === `/api/desktop/pairings/${PAIRING_ID}/activate`);
  const connectConfirmed = requestRecords.filter(record => record.journey === 'connect-confirmation' && record.url === '/api/desktop/discovery');
  const services = {
    rest: { requestCount: restRequests.length, authenticatedRequestCount: authenticatedRequests.length, journeys: unique(restRequests.map(record => record.journey)) },
    socketIo: { authenticatedConnections: socketConnections.length, events: socketEvents.length, journeys: unique(socketRecords.map(record => record.journey)) },
    pairing: { started: pairingStarted.length, polled: pairingPolled.length, activated: pairingActivated.length, journeys: unique([...pairingStarted, ...pairingPolled, ...pairingActivated].map(record => record.journey)) },
    connect: { confirmedRequests: connectConfirmed.length, journeys: unique(connectConfirmed.map(record => record.journey)) },
  };
  if (services.rest.requestCount <= 0 || services.rest.authenticatedRequestCount <= 0
    || services.socketIo.authenticatedConnections <= 0 || services.socketIo.events <= 0
    || services.pairing.started <= 0 || services.pairing.polled <= 0 || services.pairing.activated <= 0
    || services.connect.confirmedRequests <= 0) {
    throw new Error(`Acceptance packaged-renderer service journeys were incomplete: ${JSON.stringify(services)}`);
  }
  return services;
};

try {
  readyOrigin = await createFixture('ready', FIXED_ACCEPTANCE_ORIGINS.ready);
  revokedOrigin = await createFixture('revoked', FIXED_ACCEPTANCE_ORIGINS.revoked);
  incompatibleOrigin = await createFixture('incompatible', FIXED_ACCEPTANCE_ORIGINS.incompatible);
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
    return async () => {
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByRole('button', { name: 'Sign in in browser' }).waitFor();
      await waitForObserved(() => requestRecords.some(record => record.journey === 'connect-confirmation' && record.url === '/api/desktop/discovery'), 'the confirmed Connect request');
    };
  });
  await runJourney('remote-pairing', 'default', null, async page => {
    await observeLiveMutation(page, 'status', 'remote-pairing', () => fillEndpoint(page, readyOrigin, 'Remote Team'));
    await page.getByRole('button', { name: 'Sign in in browser' }).waitFor();
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
    await waitForObserved(() => {
      const journeyRequests = requestRecords.filter(record => record.journey === 'dashboard-profile-manager');
      return journeyRequests.some(record => record.method === 'POST' && record.url === '/api/desktop/pairings')
        && journeyRequests.some(record => record.method === 'POST' && record.url === `/api/desktop/pairings/${PAIRING_ID}/poll`)
        && journeyRequests.some(record => record.method === 'POST' && record.url === `/api/desktop/pairings/${PAIRING_ID}/activate`);
    }, `the complete pairing flow for ${PAIRING_ID}`);
    await waitForObserved(() => socketRecords.some(record => record.journey === 'dashboard-profile-manager' && record.authenticated), 'an authenticated Socket.IO connection');
    await waitForObserved(() => socketRecords.some(record => record.journey === 'dashboard-profile-manager' && record.event !== 'connection'), 'an authenticated renderer Socket.IO event');
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
    await application.context.tracing.stop({ path: join(outputDirectory, 'sanitized-trace.zip') });
    traceWritten = true;
  });
  await runJourney('offline', 'default', null, async page => {
    await observeLiveMutation(page, 'error', 'offline', () => fillEndpoint(page, FIXED_ACCEPTANCE_ORIGINS.offline, 'Offline Lab'));
    await page.getByText(/could not discover|could not check|unavailable/i).first().waitFor({ timeout: 15_000 });
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
  await Promise.all(pendingConsoleRecords);
  if (boundaryJourneys.size !== ACCEPTANCE_JOURNEYS.length
    || ACCEPTANCE_JOURNEYS.some(journey => !boundaryJourneys.has(journey))) throw new Error('Packaged main/preload/renderer boundary was not observed for every journey');
  const serious = axeFindings.filter(finding => finding.impact === 'serious').length;
  const critical = axeFindings.filter(finding => finding.impact === 'critical').length;
  const accessibility = {
    schemaVersion: 2,
    generatedAt: FIXED_TIME,
    serious,
    critical,
    findings: axeFindings,
    checks: accessibilityChecks,
    keyboardOrder,
    visibleFocus,
    modalFocusTrap,
    modalFocusRestore,
    accessibleNames: accessibilityChecks.every(check => check.accessibleNames),
    liveAnnouncements: { status: liveAnnouncements.status, error: liveAnnouncements.error },
  };
  await writeFile(join(outputDirectory, 'accessibility.json'), `${JSON.stringify(accessibility, null, 2)}\n`, { mode: 0o600 });

  const services = observedServiceSummary();
  const sanitizedSummary = {
    schemaVersion: 2,
    generatedAt: FIXED_TIME,
    status: 'passed',
    journeys: ACCEPTANCE_JOURNEYS.length,
    screenshots: screenshotMetadata.length,
    boundary: { packagedExecutable: true, rendererOrigin: 'propr-app://renderer', preloadBridge: true, journeys: ACCEPTANCE_JOURNEYS },
    console: { records: consoleRecords.length + pageErrorRecords.length, errors: consoleRecords.filter(record => record.type === 'error').length + pageErrorRecords.length },
    services,
    redaction: 'Full raw surfaces were scanned; published logs retain only source, level, byte count, and digest.',
  };
  await writeFile(join(outputDirectory, 'sanitized-summary.json'), `${JSON.stringify(sanitizedSummary, null, 2)}\n`, { mode: 0o600 });

  const sanitizedLogRecords = [
    ...consoleRecords.map(record => ({
      journey: record.journey, source: 'renderer-console', level: record.type,
      bytes: Buffer.byteLength(JSON.stringify(record)), sha256: digest(JSON.stringify(record)),
    })),
    ...pageErrorRecords.map(record => ({
      journey: record.journey, source: 'renderer-page-error', level: 'error',
      bytes: Buffer.byteLength(JSON.stringify(record)), sha256: digest(JSON.stringify(record)),
    })),
    ...processRecords,
  ];
  await writeFile(join(outputDirectory, 'sanitized-log.json'), `${JSON.stringify({
    schemaVersion: 1, generatedAt: FIXED_TIME, records: sanitizedLogRecords,
  }, null, 2)}\n`, { mode: 0o600 });

  const scanRoot = await mkdtemp(join(tmpdir(), ACCEPTANCE_SURFACES_PREFIX));
  try {
    surfaces.push({ kind: 'renderer-console', records: consoleRecords });
    surfaces.push({ kind: 'renderer-page-errors', records: pageErrorRecords });
    surfaces.push({ kind: 'service-urls', records: requestRecords });
    surfaces.push({ kind: 'socket-events', records: socketRecords });
    surfaces.push({ kind: 'screenshot-metadata', records: screenshotMetadata });
    surfaces.push({ kind: 'accessibility-metadata', value: accessibility });
    await writeFile(join(scanRoot, 'complete-renderer-process-network-and-metadata-surfaces.json'), JSON.stringify(surfaces), { mode: 0o600 });
    await scanAcceptancePaths([scanRoot], SENTINELS);
  } finally {
    await safeRemoveAcceptanceLeaf(scanRoot, { kind: 'surfaces' });
  }
  await writeAcceptanceManifest(outputDirectory, screenshotMetadata);
  await verifyAcceptanceArtifacts(outputDirectory, { sentinels: SENTINELS });
  console.log(`Packaged desktop acceptance produced ${screenshotMetadata.length} deterministic screenshots with zero serious/critical findings.`);
} finally {
  activeJourney = 'fixture-cleanup';
  for (const fixture of fixtures) {
    await new Promise(resolveValue => fixture.io.close(resolveValue));
    if (fixture.server.listening) await new Promise(resolveValue => fixture.server.close(resolveValue));
  }
}

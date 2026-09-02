import { lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, net, protocol, safeStorage, screen, session, shell } from 'electron';
import type { Rectangle } from 'electron';
import { DESKTOP_RENDERER_ORIGIN } from '@propr/shared';
import { DeepLinkDelivery } from './deep-link-delivery';
import { handleDeepLinkDeliveryFailure } from './deep-link-failure-policy';
import { registerIpcHandlers } from './ipc';
import { LocalLifecycleController } from './lifecycle';
import { createDesktopLogger, type DesktopLogger } from './logger';
import { ProfileStore, type EncryptionProvider } from './profile-store';
import {
  deepLinkFromArguments,
  isSafeExternalUrl,
  isTrustedRendererUrl,
  normalizeApiBaseUrl,
  normalizeDeepLink,
  rendererContentSecurityPolicy,
  validatedDevServerUrl,
} from './security';
import { DESKTOP_PROTOCOL, IPC_CHANNELS } from './shared/contract';
import type { DesktopDeepLinkConsumption } from './shared/contract';
import { checkForSignedUpdates } from './signed-updates';
import { authorizePackagedSmokeTest } from './smoke-test-authorization';
import { createPackagedSmokeEvidenceSink } from './smoke-test-evidence';
import {
  createBrowserWindowOptions,
  MINIMUM_BROWSER_WINDOW_SIZE,
  selectInitialWindowWorkArea,
} from './window-options';

const devServerUrl = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string'
  ? MAIN_WINDOW_VITE_DEV_SERVER_URL
  : undefined;
const PACKAGED_RENDERER_SCHEME = 'propr-app';
const PACKAGED_RENDERER_HOST = 'renderer';
const PACKAGED_LAYOUT_READY_EVENT = 'desktop.renderer.layout.ready';
const PACKAGED_REDUCED_NATIVE_WINDOW_READY_EVENT = 'desktop.native.reduced_window.ready';
const NATIVE_COLD_MANUAL_LINK = 'propr://connect?api=http%3A%2F%2Flocalhost%3A44111';
const NATIVE_COLD_TUNNEL_LINK = 'propr://connect?api=https%3A%2F%2Ft-native-relaunch.propr.dev';
const NATIVE_WARM_MANUAL_LINK = 'propr://connect?api=http%3A%2F%2F127.0.0.1%3A44112';
const NATIVE_WARM_TUNNEL_LINK = 'propr://connect?api=https%3A%2F%2Ft-native-evidence.propr.dev';
const NATIVE_WARM_OPEN_LINK = 'propr://open?path=%2Ftasks%3Fstatus%3Dopen';
type NativeSmokePhase = 'first' | 'relaunch';
const packagedRendererRoot = join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
const packagedRendererUrl = `${DESKTOP_RENDERER_ORIGIN}/renderer.html`;
let packagedSmokeUserDataDirectory: string | null = null;
let packagedSmokeEvidence: ReturnType<typeof createPackagedSmokeEvidenceSink> = null;
let nativeSmokePhase: NativeSmokePhase | undefined;
try {
  packagedSmokeUserDataDirectory = authorizePackagedSmokeTest({
    argv: process.argv,
    defaultUserDataDirectory: join(app.getPath('appData'), app.name),
    environmentTriggered: process.env.PROPR_DESKTOP_SMOKE_TEST === '1',
    isPackaged: app.isPackaged,
    platform: process.platform,
  });
  if (packagedSmokeUserDataDirectory) {
    const requestedNativePhase = process.env.PROPR_DESKTOP_NATIVE_ARTIFACT_PHASE;
    if (requestedNativePhase !== undefined) {
      if (requestedNativePhase !== 'first' && requestedNativePhase !== 'relaunch') {
        throw new Error('Packaged desktop native artifact phase is invalid');
      }
      nativeSmokePhase = requestedNativePhase;
    }
    const smokeDirectoryStats = lstatSync(packagedSmokeUserDataDirectory);
    if (!smokeDirectoryStats.isDirectory() || smokeDirectoryStats.isSymbolicLink()) {
      throw new Error('Packaged desktop smoke --user-data-dir must be an existing non-link directory');
    }
    app.setPath('userData', packagedSmokeUserDataDirectory);
    packagedSmokeEvidence = nativeSmokePhase
      ? createPackagedSmokeEvidenceSink(packagedSmokeUserDataDirectory, nativeSmokePhase)
      : createPackagedSmokeEvidenceSink(packagedSmokeUserDataDirectory);
    packagedSmokeEvidence?.write('desktop.smoke.authorized');
  }
} catch {
  process.exit(1);
}
const packagedSmokeTest = packagedSmokeUserDataDirectory !== null;
let mainWindow: BrowserWindow | null = null;
let nativeSmokeWindow: BrowserWindow | null = null;
const initialDeepLink = deepLinkFromArguments(process.argv);
const nativeObservedEvents = new Set<string>();
let nativeRendererReady = false;
let nativeCompletionStarted = false;
let nativeProfiles: ProfileStore | null = null;
const recordNativeEvent = (event: string): void => {
  if (!nativeSmokePhase) return;
  if (event.endsWith('_once') && nativeObservedEvents.has(event)) {
    packagedSmokeEvidence?.write('desktop.app.start_failed');
    app.exit(1);
    return;
  }
  nativeObservedEvents.add(event);
  packagedSmokeEvidence?.write(event);
};
const nativeEventForDeliveredLink = (value: string): string | null => {
  if (nativeSmokePhase === 'first') {
    if (value === NATIVE_COLD_MANUAL_LINK) return 'desktop.deeplink.cold_manual_once';
    if (value === NATIVE_WARM_MANUAL_LINK) return 'desktop.deeplink.warm_manual_once';
    if (value === NATIVE_WARM_TUNNEL_LINK) return 'desktop.deeplink.warm_tunnel_once';
    if (value === NATIVE_WARM_OPEN_LINK) return 'desktop.deeplink.warm_open_once';
  }
  if (nativeSmokePhase === 'relaunch' && value === NATIVE_COLD_TUNNEL_LINK) {
    return 'desktop.deeplink.cold_tunnel_once';
  }
  return null;
};
const assertNativeRendererConsumption = (
  value: string,
  consumption: DesktopDeepLinkConsumption,
  window: BrowserWindow,
): void => {
  const expected = value === NATIVE_COLD_MANUAL_LINK
    ? { kind: 'connect-confirmation', target: 'http://localhost:44111' }
    : value === NATIVE_COLD_TUNNEL_LINK
      ? { kind: 'connect-confirmation', target: 'https://t-native-relaunch.propr.dev' }
      : value === NATIVE_WARM_MANUAL_LINK
        ? { kind: 'connect-confirmation', target: 'http://127.0.0.1:44112' }
        : value === NATIVE_WARM_TUNNEL_LINK
          ? { kind: 'connect-confirmation', target: 'https://t-native-evidence.propr.dev' }
          : value === NATIVE_WARM_OPEN_LINK
            ? { kind: 'open-queued', target: '/tasks?status=open' }
            : null;
  if (!expected) return;
  if (consumption.kind !== expected.kind || consumption.target !== expected.target) {
    throw new Error('Native renderer deep-link acknowledgement did not prove the intended state');
  }
  if (nativeSmokePhase
    && [NATIVE_WARM_MANUAL_LINK, NATIVE_WARM_TUNNEL_LINK, NATIVE_WARM_OPEN_LINK].includes(value)
    && nativeSmokeWindow !== window) {
    throw new Error('Native warm deep link did not reach the already-running renderer');
  }
};
const deepLinkDelivery = new DeepLinkDelivery<BrowserWindow>(
  IPC_CHANNELS.deepLink,
  initialDeepLink ? [initialDeepLink] : [],
  (value, consumption, window) => {
    assertNativeRendererConsumption(value, consumption, window);
    const event = nativeEventForDeliveredLink(value);
    if (event) recordNativeEvent(event);
    maybeCompleteNativeFirstLaunch();
  },
  _error => {
    handleDeepLinkDeliveryFailure(nativeSmokePhase !== undefined, {
      exit: code => app.exit(code),
      log,
    });
  },
);
let logger: DesktopLogger | null = null;
let shutdownStarted = false;
if (process.platform === 'win32') {
  app.setAppUserModelId('dev.propr.desktop');
}

const log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => {
  packagedSmokeEvidence?.write(event);
  if (logger) {
    logger.log(level, event, fields);
  } else {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }));
  }
};

process.on('uncaughtExceptionMonitor', error => {
  log('error', 'desktop.main_process.uncaught_exception', { error });
});

protocol.registerSchemesAsPrivileged([{
  scheme: PACKAGED_RENDERER_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}]);

const registerProtocolClient = (): void => {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL, process.execPath, [process.argv[1]]);
    return;
  }
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL);
};

const deliverDeepLink = (value: string): void => {
  deepLinkDelivery.deliver(value);
};

function maybeCompleteNativeFirstLaunch(): void {
  const required = [
    'desktop.deeplink.cold_manual_once',
    'desktop.deeplink.warm_manual_once',
    'desktop.deeplink.warm_tunnel_once',
    'desktop.deeplink.warm_open_once',
    'desktop.deeplink.rejected_malformed',
    'desktop.deeplink.rejected_oversized',
    'desktop.deeplink.rejected_unsafe_scheme',
  ];
  if (nativeSmokePhase !== 'first' || !nativeRendererReady || nativeCompletionStarted
    || !required.every(event => nativeObservedEvents.has(event)) || !mainWindow || !nativeProfiles) return;
  nativeCompletionStarted = true;
  const window = mainWindow;
  void (async () => {
    const uiRequiresConfirmation = await window.webContents.executeJavaScript(`(async () => {
      const deadline = performance.now() + 2000;
      do {
        const labels = Array.from(document.querySelectorAll('.desktop-connection-card form > label'));
        if (labels[1]?.querySelector('input')?.value === 'https://t-native-evidence.propr.dev') return true;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (performance.now() < deadline);
      return false;
    })()`);
    const stored = await nativeProfiles?.list();
    const deepLinkedEndpoints = new Set([
      'http://localhost:44111',
      'http://127.0.0.1:44112',
      'https://t-native-evidence.propr.dev',
    ]);
    if (!uiRequiresConfirmation || stored?.activeProfileId !== null || stored?.profiles.length !== 2
      || stored.profiles.some(profile => deepLinkedEndpoints.has(profile.apiBaseUrl))) {
      throw new Error('Native deep-link endpoint was trusted without UI confirmation');
    }
    recordNativeEvent('desktop.deeplink.confirmation_required');
    app.quit();
  })().catch(error => {
    log('error', 'desktop.app.start_failed', { error });
    app.exit(1);
  });
}

const recordNativeRejectedArguments = (argv: readonly string[]): void => {
  if (nativeSmokePhase !== 'first') return;
  if (argv.includes('native-evidence-malformed')) {
    recordNativeEvent('desktop.deeplink.rejected_malformed');
  }
  if (argv.includes('https://native-evidence.invalid/unsafe')) {
    recordNativeEvent('desktop.deeplink.rejected_unsafe_scheme');
  }
  if (argv.some(value => value.length > 2_048 && value.startsWith('propr://connect?api='))) {
    recordNativeEvent('desktop.deeplink.rejected_oversized');
  }
  maybeCompleteNativeFirstLaunch();
};

const configureSessionSecurity = (): void => {
  const desktopSession = session.defaultSession;
  desktopSession.setPermissionCheckHandler(() => false);
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  desktopSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [rendererContentSecurityPolicy(!app.isPackaged)],
      },
    });
  });
};

const configurePackagedRendererProtocol = (): void => {
  protocol.handle(PACKAGED_RENDERER_SCHEME, request => {
    const requestUrl = new URL(request.url);
    if (requestUrl.hostname !== PACKAGED_RENDERER_HOST) {
      return new Response(null, { status: 404 });
    }

    let requestedPath: string;
    try {
      requestedPath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
    } catch {
      return new Response(null, { status: 400 });
    }
    const filePath = resolve(packagedRendererRoot, requestedPath);
    const relativePath = relative(packagedRendererRoot, filePath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      return new Response(null, { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).href);
  });
};

const openAllowedExternalUrl = async (url: string): Promise<void> => {
  if (!isSafeExternalUrl(url)) {
    log('warn', 'desktop.external_url.rejected');
    return;
  }
  await shell.openExternal(url);
};

const inspectPackagedLayout = async (window: BrowserWindow): Promise<Record<string, unknown>> => {
  const rendererLayout = await window.webContents.executeJavaScript(`(async () => {
    const deadline = performance.now() + 5000;
    let elements;
    do {
      const card = document.querySelector('.desktop-connection-card');
      const form = card?.querySelector('form');
      const labels = form ? Array.from(form.querySelectorAll(':scope > label')) : [];
      elements = {
        titlebar: document.querySelector('.desktop-titlebar'),
        logo: document.querySelector('.desktop-titlebar img[alt="ProPR"]'),
        card,
        connectionName: labels[0]?.querySelector('input'),
        apiUrl: labels[1]?.querySelector('input'),
        apiHelp: labels[1]?.querySelector('span'),
        submit: form?.querySelector(':scope > button[type="submit"]'),
        footer: card?.lastElementChild,
      };
      if (Object.values(elements).every(Boolean) && elements.footer.textContent.includes('Runtime:')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (performance.now() < deadline);

    const missing = Object.entries(elements).filter(([, element]) => !element).map(([name]) => name);
    if (missing.length > 0) return { missing };
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bounds = element => {
      const rect = element.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      };
    };
    return {
      screen: { height: window.screen.height, width: window.screen.width },
      workArea: { height: window.screen.availHeight, width: window.screen.availWidth },
      viewport: { height: window.innerHeight, width: window.innerWidth },
      ...Object.fromEntries(Object.entries(elements).map(([name, element]) => [name, bounds(element)])),
    };
  })()`);
  const [minimumWidth, minimumHeight] = window.getMinimumSize();
  return {
    windowBounds: window.getBounds(),
    contentBounds: window.getContentBounds(),
    minimumSize: { width: minimumWidth, height: minimumHeight },
    ...rendererLayout,
  };
};

const createReducedSmokeWorkArea = (displayWorkArea: Rectangle): Rectangle => {
  const width = Math.min(displayWorkArea.width, MINIMUM_BROWSER_WINDOW_SIZE.width - 80);
  const height = Math.min(displayWorkArea.height, MINIMUM_BROWSER_WINDOW_SIZE.height - 60);
  return {
    x: displayWorkArea.x + Math.floor((displayWorkArea.width - width) / 2),
    y: displayWorkArea.y + Math.floor((displayWorkArea.height - height) / 2),
    width,
    height,
  };
};

const inspectPackagedReducedNativeWindow = (): Record<string, unknown> => {
  const displayWorkArea = selectInitialWindowWorkArea(screen);
  const workArea = createReducedSmokeWorkArea(displayWorkArea);
  const probeWindow = new BrowserWindow(
    createBrowserWindowOptions(join(__dirname, 'preload.cjs'), false, workArea),
  );
  try {
    const [minimumWidth, minimumHeight] = probeWindow.getMinimumSize();
    return {
      displayWorkArea,
      workArea,
      windowBounds: probeWindow.getBounds(),
      minimumSize: { width: minimumWidth, height: minimumHeight },
    };
  } finally {
    probeWindow.destroy();
  }
};

const createMainWindow = async (): Promise<BrowserWindow> => {
  const workArea = selectInitialWindowWorkArea(screen);
  const window = new BrowserWindow(
    createBrowserWindowOptions(join(__dirname, 'preload.cjs'), !app.isPackaged, workArea),
  );
  const readyToShow = new Promise<void>(resolveReady => window.once('ready-to-show', resolveReady));

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openAllowedExternalUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url, devServerUrl, packagedRendererUrl)) return;
    event.preventDefault();
    void openAllowedExternalUrl(url);
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, details) => {
    log('error', 'desktop.renderer.gone', { reason: details.reason, exitCode: details.exitCode });
  });
  window.webContents.on('did-finish-load', () => {
    deepLinkDelivery.didFinishLoad(window);
  });
  window.on('closed', () => {
    deepLinkDelivery.clearWindow(window);
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  const validatedDevUrl = validatedDevServerUrl(devServerUrl);
  if (devServerUrl && !validatedDevUrl) throw new Error('Electron Forge supplied an unsafe renderer development URL');
  if (validatedDevUrl) {
    await window.loadURL(new URL('renderer.html', validatedDevUrl).href);
  } else {
    await window.loadURL(packagedRendererUrl);
  }

  await readyToShow;
  const preloadBridgeExposed = await window.webContents.executeJavaScript(
    "typeof window.proprDesktop === 'object' && window.proprDesktop !== null",
  );
  if (preloadBridgeExposed !== true) {
    throw new Error('Desktop preload bridge was not exposed to the renderer');
  }
  if (nativeSmokePhase && !nativeSmokeWindow) nativeSmokeWindow = window;
  deepLinkDelivery.setWindow(window);
  if (nativeSmokePhase) await deepLinkDelivery.whenIdle();
  const smokeProfileApiUrl = process.env.PROPR_DESKTOP_SMOKE_PROFILE_API_URL;
  if (packagedSmokeTest && smokeProfileApiUrl) {
    const normalizedSmokeApiUrl = normalizeApiBaseUrl(smokeProfileApiUrl);
    if (!normalizedSmokeApiUrl || normalizedSmokeApiUrl !== smokeProfileApiUrl) {
      throw new Error('Packaged desktop smoke profile API URL is invalid');
    }
    const endpoints = [
      `${normalizedSmokeApiUrl}/api/compatibility`,
      `${normalizedSmokeApiUrl}/api/desktop/discovery`,
    ];
    const result = await window.webContents.executeJavaScript(`(async () => {
      const results = [];
      for (const endpoint of ${JSON.stringify(endpoints)}) {
        const response = await fetch(endpoint, { credentials: 'include' });
        results.push({ ok: response.ok, status: response.status, body: await response.json() });
      }
      return results;
    })()`);
    if (result?.[0]?.ok !== true || result[0]?.body?.profileEndpoint !== true
      || result?.[1]?.ok !== true || result[1]?.body?.product !== 'ProPR'
      || result[1]?.body?.desktopAuthentication?.protocolVersion !== 1) {
      throw new Error('Packaged renderer profile API or ProPR Connect discovery request failed');
    }
    log('info', 'desktop.renderer.profile_api.ready', { origin: DESKTOP_RENDERER_ORIGIN });
  }
  if (nativeSmokePhase) {
    const profiles = await nativeProfiles?.list();
    const expectedInitialApi = nativeSmokePhase === 'first'
      ? 'http://localhost:44111'
      : 'https://t-native-relaunch.propr.dev';
    const initialEndpointVisible = await window.webContents.executeJavaScript(`(async () => {
      const deadline = performance.now() + 2000;
      do {
        const labels = Array.from(document.querySelectorAll('.desktop-connection-card form > label'));
        if (labels[1]?.querySelector('input')?.value === ${JSON.stringify(expectedInitialApi)}) return true;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (performance.now() < deadline);
      return false;
    })()`);
    if (!initialEndpointVisible || !profiles) {
      throw new Error('Native cold deep link did not reach the confirmation UI');
    }
    if (nativeSmokePhase === 'first') {
      if (profiles.profiles.length !== 0 || profiles.activeProfileId !== null) {
        throw new Error('Native first launch did not start with an isolated profile');
      }
      await nativeProfiles?.save({
        id: 'native-local',
        label: 'Preserved local profile',
        apiBaseUrl: 'http://localhost:44221',
      });
      await nativeProfiles?.save({
        id: 'native-tunnel',
        label: 'Native ProPR Connect tunnel',
        apiBaseUrl: 'https://t-preserved.propr.dev',
      });
      recordNativeEvent('desktop.native.secure_storage_probe.started');
      const storage = nativeProfiles?.security();
      const credentialWrite = await nativeProfiles?.writeCredential('native-local', 'native-custody-probe');
      if (!storage || !credentialWrite) throw new Error('Native secure-storage custody probe did not run');
      if (process.platform === 'linux') {
        if (storage.available || credentialWrite.stored
          || (await nativeProfiles?.readCredential('native-local'))?.available !== false) {
          throw new Error('Native Linux fallback-only proof unexpectedly claimed libsecret custody');
        }
        recordNativeEvent('desktop.native.secure_storage_fallback_refused');
      } else if (storage.available) {
        if (storage.backend === 'basic_text' || !credentialWrite.stored
          || (await nativeProfiles?.readCredential('native-local'))?.value !== 'native-custody-probe') {
          throw new Error('Native secure-storage custody probe did not use OS encryption');
        }
        await nativeProfiles?.removeCredential('native-local');
        if ((await nativeProfiles?.readCredential('native-local'))?.value !== null) {
          throw new Error('Native secure-storage custody probe cleanup failed');
        }
      } else if (credentialWrite.stored
        || (await nativeProfiles?.readCredential('native-local'))?.available !== false) {
        throw new Error('Native secure-storage custody probe allowed plaintext fallback');
      }
      if (process.platform === 'darwin' && (!storage.available || storage.backend !== 'os-protected')) {
        throw new Error('Native macOS artifact did not retain Keychain-backed custody');
      }
      recordNativeEvent('desktop.native.secure_storage_probe.completed');
      recordNativeEvent('desktop.native.secure_storage_enforced');
      recordNativeEvent('desktop.native.profile_fresh');
    } else {
      const expected = new Map([
        ['native-local', 'http://localhost:44221'],
        ['native-tunnel', 'https://t-preserved.propr.dev'],
      ]);
      if (profiles.activeProfileId !== null || profiles.profiles.length !== expected.size
        || profiles.profiles.some(profile => expected.get(profile.id) !== profile.apiBaseUrl)) {
        throw new Error('Native relaunch did not preserve the non-secret profile state exactly');
      }
      recordNativeEvent('desktop.native.profile_preserved');
      recordNativeEvent('desktop.deeplink.confirmation_required');
    }
  } else if (packagedSmokeTest) {
    const profileFlow = await window.webContents.executeJavaScript(`(async () => {
      const bridge = window.proprDesktop;
      const local = await bridge.profiles.save({ label: 'Local setup', apiBaseUrl: 'http://localhost:4000' });
      const remote = await bridge.profiles.save({ label: 'ProPR Connect', apiBaseUrl: 'https://connect.propr.dev' });
      await bridge.profiles.setActive(remote.id);
      const profiles = await bridge.profiles.list();
      const lifecycle = await bridge.lifecycle.start();
      const deadline = performance.now() + 2000;
      let connectDeepLink = false;
      do {
        const labels = Array.from(document.querySelectorAll('.desktop-connection-card form > label'));
        connectDeepLink = labels[1]?.querySelector('input')?.value === 'https://connect.propr.dev';
        if (connectDeepLink) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (performance.now() < deadline);
      return {
        active: profiles.activeProfileId === remote.id,
        local: profiles.profiles.some(profile => profile.id === local.id && profile.apiBaseUrl === 'http://localhost:4000'),
        remote: profiles.profiles.some(profile => profile.id === remote.id && profile.apiBaseUrl === 'https://connect.propr.dev'),
        lifecycleBoundary: lifecycle.ok === false && lifecycle.code === 'not-implemented',
        connectDeepLink,
      };
    })()`);
    if (!profileFlow?.active || !profileFlow?.local || !profileFlow?.remote
      || !profileFlow?.lifecycleBoundary || !profileFlow?.connectDeepLink) {
      throw new Error('Packaged desktop local/remote/API profile flow failed');
    }
    log('info', 'desktop.renderer.mvp_flows.ready', { connectDiscovery: true });
    log('info', PACKAGED_LAYOUT_READY_EVENT, { layout: await inspectPackagedLayout(window) });
    log('info', PACKAGED_REDUCED_NATIVE_WINDOW_READY_EVENT, {
      layout: inspectPackagedReducedNativeWindow(),
    });
  }
  log('info', 'desktop.renderer.ready', { preloadBridgeExposed: true });
  nativeRendererReady = true;
  maybeCompleteNativeFirstLaunch();
  if (packagedSmokeTest && nativeSmokePhase !== 'first') {
    app.quit();
  } else {
    window.show();
  }
  return window;
};

app.on('open-url', (event, url) => {
  event.preventDefault();
  const normalized = normalizeDeepLink(url);
  if (normalized) deliverDeepLink(normalized);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const deepLink = deepLinkFromArguments(argv);
    if (deepLink) deliverDeepLink(deepLink);
    else recordNativeRejectedArguments(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  registerProtocolClient();
  void app.whenReady().then(async () => {
    logger = createDesktopLogger(
      join(app.getPath('logs'), 'desktop.jsonl'),
      () => packagedSmokeEvidence?.write('desktop.log.write_failed'),
    );
    log('info', 'desktop.app.ready', { version: app.getVersion(), platform: process.platform });
    if (nativeSmokePhase) {
      const expectedVersion = process.env.PROPR_DESKTOP_NATIVE_EXPECTED_VERSION;
      const expectedPlatform = process.env.PROPR_DESKTOP_NATIVE_EXPECTED_PLATFORM;
      const expectedArch = process.env.PROPR_DESKTOP_NATIVE_EXPECTED_ARCH;
      if (!expectedVersion || app.getVersion() !== expectedVersion
        || expectedPlatform !== process.platform || expectedArch !== process.arch) {
        throw new Error('Native artifact application identity, version, or architecture mismatch');
      }
      recordNativeEvent('desktop.native.identity_verified');
    }
    configureSessionSecurity();
    configurePackagedRendererProtocol();

    const encryption: EncryptionProvider = {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      backend: () => {
        if (process.platform !== 'linux') return 'os-protected';
        try {
          return safeStorage.getSelectedStorageBackend();
        } catch {
          return 'unavailable';
        }
      },
      encrypt: value => safeStorage.encryptString(value),
      decrypt: value => safeStorage.decryptString(value),
    };
    const profiles = new ProfileStore(app.getPath('userData'), encryption);
    nativeProfiles = profiles;
    const lifecycle = new LocalLifecycleController();
    registerIpcHandlers({
      app,
      ipcMain,
      profiles,
      lifecycle,
      logger,
      desktopSession: session.defaultSession,
      devServerUrl,
      packagedRendererUrl,
      acknowledgeDeepLink: (event, acknowledgement) =>
        deepLinkDelivery.acknowledgeSender(event.sender, acknowledgement),
    });

    app.on('before-quit', event => {
      if (shutdownStarted) return;
      event.preventDefault();
      shutdownStarted = true;
      void lifecycle.shutdown().finally(() => {
        log('info', 'desktop.app.shutdown');
        app.quit();
      });
    });

    mainWindow = await createMainWindow();

    const updateConfig = __PROPR_DESKTOP_UPDATE_MANIFEST_URL__
      ? {
          manifestUrl: __PROPR_DESKTOP_UPDATE_MANIFEST_URL__,
          publicKey: __PROPR_DESKTOP_UPDATE_PUBLIC_KEY__,
          signingIdentity: __PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY__,
          windowsSignerPins: __PROPR_DESKTOP_WINDOWS_SIGNER_PINS__,
        }
      : undefined;
    if (app.isPackaged && process.platform !== 'win32' && updateConfig && !packagedSmokeTest) {
      const runUpdateCheck = () => {
        void checkForSignedUpdates({
          config: updateConfig,
          currentVersion: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          request: (url, init) => net.fetch(url, init),
          cacheDirectory: join(app.getPath('userData'), 'verified-updates'),
        }).then(result => log('info', 'desktop.update.check_complete', { result }))
          .catch(() => log('error', 'desktop.update.check_failed'));
      };
      runUpdateCheck();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow().then(window => {
          mainWindow = window;
        });
      }
    });

  }).catch(error => {
    log('error', 'desktop.app.start_failed', { error });
    app.exit(1);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  packagedSmokeEvidence?.close();
  packagedSmokeEvidence = null;
});

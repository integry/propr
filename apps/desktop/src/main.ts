import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, crashReporter, ipcMain, net, protocol, safeStorage, screen, session, shell } from 'electron';
import {
  DESKTOP_RENDERER_ORIGIN,
  DESKTOP_TRANSPORT_SCOPE_HEADER,
  PROPR_API_COMPATIBILITY,
  PROPR_UI_COMPATIBILITY,
} from '@propr/shared';
import {
  DESKTOP_CONNECT_DISCOVERY_PLATFORMS,
  discoverConfiguredConnect,
} from '@propr/cli/desktop-discovery';
import { DesktopConnectDiscoveryService } from './connect-discovery';
import { DeepLinkDelivery } from './deep-link-delivery';
import { clearDesktopInstanceCookies } from './desktop-session';
import { DesktopCredentialService } from './credential-service';
import { registerIpcHandlers } from './ipc';
import { LocalLifecycleController } from './lifecycle';
import { createDesktopLogger, type DesktopLogger } from './logger';
import { ProfileStore, type EncryptionProvider } from './profile-store';
import { openApprovedDesktopPairingUrl } from './pairing-browser';
import { createDesktopShutdownCoordinator } from './shutdown';
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
import { createBrowserWindowOptions } from './window-options';

const devServerUrl = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string'
  ? MAIN_WINDOW_VITE_DEV_SERVER_URL
  : undefined;
const PACKAGED_RENDERER_SCHEME = 'propr-app';
const PACKAGED_RENDERER_HOST = 'renderer';
const PACKAGED_LAYOUT_READY_EVENT = 'desktop.renderer.layout.ready';
const packagedRendererRoot = join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
const packagedRendererUrl = `${DESKTOP_RENDERER_ORIGIN}/renderer.html`;
let mainWindow: BrowserWindow | null = null;
const initialDeepLink = deepLinkFromArguments(process.argv);
const deepLinkDelivery = new DeepLinkDelivery<BrowserWindow>(
  IPC_CHANNELS.deepLink,
  initialDeepLink ? [initialDeepLink] : [],
);
let logger: DesktopLogger | null = null;
let shutdownStarted = false;

interface PackagedTransportSmoke {
  firstOrigin: string;
  secondOrigin: string;
  shutdownMode: 'success' | 'retry' | 'forced-timeout';
}

interface PackagedConnectSmoke {
  configRoot: string;
  fetch: typeof globalThis.fetch;
}

const packagedConnectSmoke = (): PackagedConnectSmoke | null => {
  if (!app.isPackaged || process.env.PROPR_DESKTOP_CONNECT_SMOKE_TEST !== '1') return null;
  const suppliedRoot = process.env.PROPR_DESKTOP_CONNECT_SMOKE_CONFIG_ROOT;
  if (!suppliedRoot || !isAbsolute(suppliedRoot)) throw new Error('Packaged Connect smoke requires an isolated config root');
  const configRoot = realpathSync.native(suppliedRoot);
  const temporaryRoot = realpathSync.native(app.getPath('temp'));
  const contained = relative(temporaryRoot, configRoot);
  if (!contained || contained.startsWith('..') || isAbsolute(contained)) {
    throw new Error('Packaged Connect smoke config root is outside the temporary directory');
  }
  const endpoint = 'https://t-packaged123.propr.dev';
  const publicInstanceIdentity = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const fetch: typeof globalThis.fetch = async input => {
    if (input.toString() !== `${endpoint}/api/desktop/discovery`) {
      throw new Error('Packaged Connect smoke rejected an unexpected network request');
    }
    return new Response(JSON.stringify({
      schemaVersion: 1,
      product: 'ProPR',
      version: app.getVersion(),
      apiCompatibility: PROPR_API_COMPATIBILITY,
      uiCompatibility: PROPR_UI_COMPATIBILITY,
      canonicalEndpoint: endpoint,
      publicInstanceIdentity,
      desktopAuthentication: {
        protocolVersion: 2,
        browserPairing: true,
        instanceBearerTokens: true,
        socketIoBearerAuthentication: true,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { configRoot, fetch };
};

const packagedTransportSmoke = (): PackagedTransportSmoke | null => {
  if (!app.isPackaged || process.env.PROPR_DESKTOP_SMOKE_TEST !== '1') return null;
  const firstOrigin = normalizeApiBaseUrl(process.env.PROPR_DESKTOP_SMOKE_FIRST_ORIGIN ?? '');
  const secondOrigin = normalizeApiBaseUrl(process.env.PROPR_DESKTOP_SMOKE_SECOND_ORIGIN ?? '');
  const shutdownMode = process.env.PROPR_DESKTOP_SMOKE_SHUTDOWN_MODE;
  const isolatedUserData = basename(app.getPath('userData')).startsWith('propr-desktop-smoke-');
  const loopback = (origin: string | null): origin is string => origin !== null
    && new URL(origin).hostname === '127.0.0.1';
  if (!isolatedUserData || !loopback(firstOrigin) || !loopback(secondOrigin) || firstOrigin === secondOrigin
    || (shutdownMode !== 'success' && shutdownMode !== 'retry' && shutdownMode !== 'forced-timeout')) {
    throw new Error('Packaged desktop transport smoke requires two distinct loopback fixtures and isolated user data');
  }
  return { firstOrigin, secondOrigin, shutdownMode };
};

const log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) =>
  logger
    ? logger.log(level, event, fields)
    : console.error(JSON.stringify({ timestamp: new Date().toISOString(), level, event, code: fields ? 'DETAIL_REDACTED' : undefined }));

process.on('uncaughtExceptionMonitor', () => {
  log('error', 'desktop.main_process.uncaught_exception', { code: 'UNCAUGHT_EXCEPTION' });
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

const configureSessionSecurity = (credentials: DesktopCredentialService): {
  close(): void;
  dispose(): void;
} => {
  const desktopSession = session.defaultSession;
  desktopSession.setPermissionCheckHandler(() => false);
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  desktopSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback(credentials.prepareRequest(details.url, details.requestHeaders, {
      method: details.method,
      resourceType: details.resourceType,
    }));
  });
  desktopSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...credentials.sanitizeResponseHeaders(details.url, details.responseHeaders ?? {}),
        'Content-Security-Policy': [rendererContentSecurityPolicy(!app.isPackaged)],
      },
    });
  });
  return {
    close() {
      desktopSession.webRequest.onBeforeSendHeaders((_details, callback) => callback({ cancel: true }));
      desktopSession.webRequest.onHeadersReceived((_details, callback) => callback({ cancel: true }));
    },
    dispose() {
      desktopSession.setPermissionCheckHandler(null);
      desktopSession.setPermissionRequestHandler(null);
      desktopSession.webRequest.onBeforeSendHeaders(null);
      desktopSession.webRequest.onHeadersReceived(null);
    },
  };
};

const configurePackagedRendererProtocol = (): (() => void) => {
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
  return () => { void protocol.unhandle(PACKAGED_RENDERER_SCHEME); };
};

const openAllowedExternalUrl = async (url: string): Promise<void> => {
  if (shutdownStarted) return;
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
      const card = document.querySelector('.desktop-welcome-card');
      const connectButton = card?.querySelector('.desktop-choice-button');
      elements = {
        entry: document.querySelector('.desktop-entry'),
        card,
        logo: card?.querySelector('.desktop-brand img'),
        heading: card?.querySelector('.desktop-welcome-copy h1'),
        connectButton,
        connectDescription: connectButton?.querySelector('small'),
      };
      if (Object.values(elements).every(Boolean)) break;
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
      viewport: { height: window.innerHeight, width: window.innerWidth },
      ...Object.fromEntries(Object.entries(elements).map(([name, element]) => [name, bounds(element)])),
    };
  })()`);
  const windowBounds = window.getBounds();
  return {
    windowBounds,
    workArea: screen.getDisplayMatching(windowBounds).workArea,
    ...rendererLayout,
  };
};

const runPackagedConnectDiscoverySmoke = async (window: BrowserWindow): Promise<void> => {
  const proof = await window.webContents.executeJavaScript(`(async () => {
    const bridge = window.proprDesktop;
    const metadata = await bridge.app.getMetadata();
    const candidates = await bridge.discovery.discover();
    return { supported: bridge.discovery.supported, metadata, candidates };
  })()`);
  const candidate = proof?.candidates?.[0];
  if (proof?.supported !== true
    || proof.metadata?.packaged !== true
    || proof.metadata?.platform !== process.platform
    || proof.metadata?.arch !== process.arch
    || !Array.isArray(proof.candidates)
    || proof.candidates.length !== 1
    || !candidate
    || Object.keys(candidate).sort().join(',') !== 'apiBaseUrl,id,label'
    || candidate.id !== 'propr-connect-discovered'
    || candidate.label !== 'ProPR Connect'
    || candidate.apiBaseUrl !== 'https://t-packaged123.propr.dev') {
    throw new Error('Packaged Connect renderer discovery proof was invalid');
  }
  log('info', 'desktop.renderer.connect_discovery.ready', {
    selectedPlatform: process.platform,
    selectedArch: process.arch,
    authorityMechanism: process.platform === 'darwin'
      ? 'packaged-broker'
      : process.platform === 'linux'
        ? 'in-process-native-addon'
        : 'inherited-standard-handle',
    rendererSchemaValid: true,
  });
};

const runPackagedTransportSmoke = async (
  window: BrowserWindow,
  profiles: ProfileStore,
  credentials: DesktopCredentialService,
  smoke: PackagedTransportSmoke,
): Promise<void> => {
  const profileId = 'packaged-transport-smoke';
  const tokenA = `propr_it_${randomBytes(32).toString('base64url')}`;
  const tokenB = `propr_it_${randomBytes(32).toString('base64url')}`;
  const security = profiles.security();
  if (!security.available || security.backend === 'basic_text') {
    throw new Error('Packaged transport smoke requires the production OS credential backend');
  }
  const profileA = await profiles.save({
    id: profileId, label: 'Packaged transport A', apiBaseUrl: smoke.firstOrigin,
  });
  const storedA = await profiles.writeCredential({ version: 1, profileId, origin: smoke.firstOrigin, token: tokenA });
  if (!storedA.stored) throw new Error('Production credential encryption was unavailable');

  const storageWindows = await Promise.all([smoke.firstOrigin, smoke.secondOrigin].map(async origin => {
    const storageWindow = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    });
    await storageWindow.loadURL(`${origin}/smoke-storage`);
    return { origin, window: storageWindow };
  }));
  const seedStorage = async (): Promise<void> => {
    await Promise.all(storageWindows.map(item => item.window.webContents.executeJavaScript(`(async () => {
        document.cookie = 'packaged-smoke-cookie=present; SameSite=Lax';
        localStorage.setItem('packaged-smoke-local', 'present');
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('packaged-smoke-indexeddb', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('proof');
          request.onsuccess = () => { request.result.close(); resolve(true); };
          request.onerror = () => reject(request.error);
        });
        const cache = await caches.open('packaged-smoke-cache');
        await cache.put('/packaged-smoke-cache-entry', new Response('present'));
        await navigator.serviceWorker.register('/smoke-sw.js');
        await navigator.serviceWorker.ready;
        return true;
      })()`)));
  };
  const storageState = async (expected: 'present' | 'absent'): Promise<boolean> => {
    const states = await Promise.all(storageWindows.map(async item => {
      const rendererState = await item.window.webContents.executeJavaScript(`(async () => ({
        cookie: document.cookie.includes('packaged-smoke-cookie=present'),
        localStorage: localStorage.getItem('packaged-smoke-local') === 'present',
        indexedDB: (await indexedDB.databases()).some(database => database.name === 'packaged-smoke-indexeddb'),
        cacheStorage: (await caches.keys()).includes('packaged-smoke-cache'),
        serviceWorker: (await navigator.serviceWorker.getRegistrations()).some(registration => registration.scope.startsWith(location.origin)),
      }))()`);
      const cookies = await session.defaultSession.cookies.get({ url: item.origin });
      return { ...rendererState, cookie: rendererState.cookie || cookies.length > 0 } as Record<string, boolean>;
    }));
    return states.every(state => Object.values(state).every(value => value === (expected === 'present')));
  };

  try {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (window.__proprPackagedTransportSmoke) return resolve(true);
        if (Date.now() - started > 5000) return reject(new Error('Packaged renderer smoke harness timed out'));
        setTimeout(poll, 20);
      };
      poll();
    })`);
    const profileForRendererA = { id: profileId, name: profileA.label, baseUrl: smoke.firstOrigin, kind: 'local' };
    const first = await window.webContents.executeJavaScript(`(async () => {
      const smoke = window.__proprPackagedTransportSmoke;
      const first = await smoke.activate(${JSON.stringify(profileForRendererA)});
      await smoke.rest();
      const socketId = await smoke.connectSocket();
      const rotated = await smoke.activate(${JSON.stringify(profileForRendererA)});
      let staleRestRejected = false;
      try {
        const response = await fetch(${JSON.stringify(smoke.firstOrigin + '/api/smoke/rest')}, {
          headers: { ${JSON.stringify(DESKTOP_TRANSPORT_SCOPE_HEADER)}: first.transportScope },
          credentials: 'include',
        });
        staleRestRejected = !response.ok;
      } catch { staleRestRejected = true; }
      await smoke.expectSocketRejected(socketId);
      await smoke.rest();
      localStorage.setItem('packaged-smoke-local', 'non-secret sentinel');
      sessionStorage.setItem('packaged-smoke-session', 'non-secret sentinel');
      return { first, rotated, socketId, staleRestRejected, rendererOrigin: location.origin };
    })()`);
    if (first?.rendererOrigin !== DESKTOP_RENDERER_ORIGIN || first?.first?.profileId !== profileId
      || first?.first?.transportScope === first?.rotated?.transportScope
      || first?.first?.contractsContainSecret !== false || first?.rotated?.contractsContainSecret !== false
      || first?.staleRestRejected !== true) {
      throw new Error('Packaged renderer protocol or A transport smoke proof failed');
    }
    await seedStorage();
    if (!await storageState('present')) throw new Error('Packaged origin storage fixture was incomplete');

    let cleanupFailed = false;
    try {
      await credentials.saveProfile({
        id: profileId, label: 'Packaged transport B', apiBaseUrl: smoke.secondOrigin,
      }, async () => { throw new Error('packaged cleanup failure'); });
    } catch (error) {
      cleanupFailed = error instanceof Error && error.message === 'packaged cleanup failure';
    }
    const rollback = await profiles.readProfileCredential(profileId);
    if (!cleanupFailed || rollback.profile?.apiBaseUrl !== smoke.firstOrigin
      || rollback.credential?.origin !== smoke.firstOrigin || rollback.credential.token !== tokenA
      || !await storageState('present')) {
      throw new Error('Origin cleanup failure did not preserve complete durable A');
    }
    let precommitStorageCleared = false;
    await credentials.saveProfile({
      id: profileId, label: 'Packaged transport B', apiBaseUrl: smoke.secondOrigin,
    }, async (previousOrigin, nextOrigin) => {
      await clearDesktopInstanceCookies(session.defaultSession, [previousOrigin, nextOrigin]);
      precommitStorageCleared = await storageState('absent');
      if (!precommitStorageCleared) throw new Error('Complete origin storage was not cleared before commit');
    });
    if (!precommitStorageCleared || !await storageState('absent')) {
      throw new Error('Same-ID URL edit did not clear both complete Electron origin stores');
    }
    const storedB = await profiles.writeCredential({ version: 1, profileId, origin: smoke.secondOrigin, token: tokenB });
    if (!storedB.stored) throw new Error('Replacement credential encryption was unavailable');

    const profileForRendererB = { id: profileId, name: 'Packaged transport B', baseUrl: smoke.secondOrigin, kind: 'local' };
    const second = await window.webContents.executeJavaScript(`(async () => {
      const smoke = window.__proprPackagedTransportSmoke;
      const activated = await smoke.activate(${JSON.stringify(profileForRendererB)});
      const socketId = await smoke.connectSocket();
      await smoke.reconnectSocket(socketId);
      const staleClassification = await smoke.handleStaleInvalidation(
        ${JSON.stringify(profileId)}, ${JSON.stringify(first.rotated.transportScope)}
      );
      smoke.disconnectSocket(${JSON.stringify(first.socketId)});
      await smoke.rest();
      const persisted = await window.proprDesktop.profiles.list();
      const rendererEvidence = smoke.rendererEvidence();
      return {
        activated,
        staleClassification,
        persisted,
        rendererEvidence,
        rendererPersistenceContainsSecret: JSON.stringify([persisted, rendererEvidence]).includes('propr_it_'),
      };
    })()`);
    const secretInMainMetadata = [tokenA, tokenB].some(secret =>
      process.argv.some(argument => argument.includes(secret))
      || JSON.stringify(crashReporter.getParameters()).includes(secret));
    if (second?.staleClassification !== 'retryable' || second?.activated?.profileId !== profileId
      || second?.activated?.contractsContainSecret !== false
      || second?.rendererPersistenceContainsSecret !== false
      || secretInMainMetadata) {
      throw new Error('Packaged replacement scope or secret-custody smoke proof failed');
    }
    log('info', 'desktop.renderer.transport_smoke.ready', {
      customProtocol: true,
      restBearer: true,
      socketIo: true,
      engineIoHandshake: true,
      namespaceAuthentication: true,
      reconnectAndErrorHandling: true,
      scopeRotation: true,
      allOriginStorageCleared: true,
      cleanupRollbackAndRetry: true,
      staleScopeRejected: true,
      secretCustody: true,
      productionCredentialRoundTrip: true,
      storageBackend: security.backend,
    });
  } finally {
    for (const item of storageWindows) {
      if (!item.window.isDestroyed()) item.window.destroy();
    }
  }
};

const createMainWindow = async (
  transportSmoke: PackagedTransportSmoke | null,
): Promise<BrowserWindow> => {
  const window = new BrowserWindow(createBrowserWindowOptions(join(__dirname, 'preload.cjs'), !app.isPackaged));
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
    if (mainWindow === window) {
      mainWindow = null;
      deepLinkDelivery.clearWindow(window);
    }
  });

  const validatedDevUrl = validatedDevServerUrl(devServerUrl);
  if (devServerUrl && !validatedDevUrl) throw new Error('Electron Forge supplied an unsafe renderer development URL');
  if (validatedDevUrl) {
    await window.loadURL(new URL('renderer.html', validatedDevUrl).href);
  } else {
    const rendererUrl = new URL(packagedRendererUrl);
    if (transportSmoke) rendererUrl.hash = 'packaged-transport-smoke';
    await window.loadURL(rendererUrl.href);
  }

  await readyToShow;
  const preloadBridgeExposed = await window.webContents.executeJavaScript(
    "typeof window.proprDesktop === 'object' && window.proprDesktop !== null",
  );
  if (preloadBridgeExposed !== true) {
    throw new Error('Desktop preload bridge was not exposed to the renderer');
  }
  if (app.isPackaged && process.env.PROPR_DESKTOP_SMOKE_TEST === '1') {
    log('info', PACKAGED_LAYOUT_READY_EVENT, { layout: await inspectPackagedLayout(window) });
  }
  log('info', 'desktop.renderer.ready', { preloadBridgeExposed: true });
  return window;
};

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (shutdownStarted) return;
  const normalized = normalizeDeepLink(url);
  if (normalized) deliverDeepLink(normalized);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (shutdownStarted) return;
    const deepLink = deepLinkFromArguments(argv);
    if (deepLink) deliverDeepLink(deepLink);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  registerProtocolClient();
  void app.whenReady().then(async () => {
    logger = createDesktopLogger(join(app.getPath('logs'), 'desktop.jsonl'));
    log('info', 'desktop.app.ready', { version: app.getVersion(), platform: process.platform });
    const disposeRendererProtocol = configurePackagedRendererProtocol();
    const transportSmoke = packagedTransportSmoke();
    const connectSmoke = packagedConnectSmoke();
    if (transportSmoke && connectSmoke) throw new Error('Packaged desktop smoke modes are mutually exclusive');

    const productionEncryption: EncryptionProvider = {
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
    const profiles = new ProfileStore(app.getPath('userData'), productionEncryption);
    const connectDiscovery = new DesktopConnectDiscoveryService(profiles, {
      supported: DESKTOP_CONNECT_DISCOVERY_PLATFORMS.has(process.platform),
      discover: async () => {
        const status = await discoverConfiguredConnect({
          configRoot: connectSmoke?.configRoot ?? join(app.getPath('home'), '.propr'),
          statusDependencies: connectSmoke ? {
            fetchImpl: connectSmoke.fetch,
            inspectTunnel: () => ({ kind: 'ok', running: true }),
          } : undefined,
          reportSmokeDiagnostic: connectSmoke
            ? diagnostic => log('info', 'desktop.renderer.connect_discovery.phase', {
                phase: diagnostic.phase,
                code: diagnostic.code,
              })
            : undefined,
        });
        if (connectSmoke) {
          const statusCode = {
            incompatible: 'CONNECT_STATUS_INCOMPATIBLE',
            internalFailure: 'CONNECT_STATUS_INTERNAL_FAILURE',
            invalidConfig: 'CONNECT_STATUS_INVALID_CONFIG',
            notReady: 'CONNECT_STATUS_NOT_READY',
            ready: 'CONNECT_STATUS_READY',
            timeout: 'CONNECT_STATUS_TIMEOUT',
          }[status.status];
          log('info', 'desktop.renderer.connect_discovery.status', { code: statusCode });
        }
        return status;
      },
    });
    const credentials = new DesktopCredentialService({
      profiles,
      fetch: session.defaultSession.fetch.bind(session.defaultSession) as typeof globalThis.fetch,
      openPairingBrowser: request => openApprovedDesktopPairingUrl(request, shell),
      clientName: `ProPR Desktop (${process.platform})`,
      reportRevocationFailure: diagnostic => {
        log('warn', 'desktop.credential_revocation.retry_pending', diagnostic);
      },
    });
    const sessionSecurity = configureSessionSecurity(credentials);
    const credentialInitialization = await credentials.initialize();
    if (credentialInitialization.status === 'degraded') {
      log('warn', 'desktop.credential_revocation.startup_degraded', {
        retryPending: credentialInitialization.retryPending,
      });
    }
    const lifecycle = new LocalLifecycleController();
    const registeredIpc = registerIpcHandlers({
      app,
      ipcMain,
      profiles,
      credentials,
      connectDiscovery,
      lifecycle,
      logger,
      desktopSession: session.defaultSession,
      devServerUrl,
      packagedRendererUrl,
      openExternal: openAllowedExternalUrl,
    });
    mainWindow = await createMainWindow(transportSmoke);
    deepLinkDelivery.setWindow(mainWindow);

    app.on('activate', () => {
      if (shutdownStarted) return;
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow(null).then(window => {
          mainWindow = window;
          deepLinkDelivery.setWindow(window);
        });
      }
    });

    const shutdownLifecycle = transportSmoke?.shutdownMode === 'forced-timeout'
      ? { shutdown: () => new Promise<void>(() => undefined) }
      : lifecycle;
    const shutdown = createDesktopShutdownCoordinator({
      credentials,
      lifecycle: shutdownLifecycle,
      ipc: registeredIpc,
      profiles,
      sessionSecurity,
      disposeRendererProtocol,
      getWindow: () => mainWindow,
      quit: () => app.quit(),
      onStarted: () => { shutdownStarted = true; },
      log,
    }, transportSmoke?.shutdownMode === 'forced-timeout' ? { drainTimeoutMs: 250 } : undefined);
    app.on('before-quit', event => shutdown.beforeQuit(event));

    if (connectSmoke) {
      await runPackagedConnectDiscoverySmoke(mainWindow);
      app.quit();
    } else if (transportSmoke) {
      await runPackagedTransportSmoke(mainWindow, profiles, credentials, transportSmoke);
      app.quit();
      if (transportSmoke.shutdownMode === 'retry') {
        log('info', 'desktop.app.shutdown_retry_requested');
        app.quit();
      }
    } else {
      mainWindow.show();
    }
  }).catch(error => {
    log('error', 'desktop.app.start_failed', { error });
    app.exit(1);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

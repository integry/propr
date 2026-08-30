import { randomBytes } from 'node:crypto';
import { isAbsolute, basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, crashReporter, ipcMain, net, protocol, safeStorage, session, shell } from 'electron';
import {
  DESKTOP_RENDERER_ORIGIN,
  DESKTOP_TRANSPORT_SCOPE_HEADER,
  DESKTOP_TRANSPORT_SCOPE_QUERY,
} from '@propr/shared';
import { DeepLinkDelivery } from './deep-link-delivery';
import { DesktopCredentialService } from './credential-service';
import { registerIpcHandlers } from './ipc';
import { LocalLifecycleController } from './lifecycle';
import { createDesktopLogger, type DesktopLogger } from './logger';
import { ProfileStore, type EncryptionProvider } from './profile-store';
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
}

const packagedTransportSmoke = (): PackagedTransportSmoke | null => {
  if (!app.isPackaged || process.env.PROPR_DESKTOP_SMOKE_TEST !== '1') return null;
  const firstOrigin = normalizeApiBaseUrl(process.env.PROPR_DESKTOP_SMOKE_FIRST_ORIGIN ?? '');
  const secondOrigin = normalizeApiBaseUrl(process.env.PROPR_DESKTOP_SMOKE_SECOND_ORIGIN ?? '');
  const isolatedUserData = basename(app.getPath('userData')).startsWith('propr-desktop-smoke-');
  const loopback = (origin: string | null): origin is string => origin !== null
    && new URL(origin).hostname === '127.0.0.1';
  if (!isolatedUserData || !loopback(firstOrigin) || !loopback(secondOrigin) || firstOrigin === secondOrigin) {
    throw new Error('Packaged desktop transport smoke requires two distinct loopback fixtures and isolated user data');
  }
  return { firstOrigin, secondOrigin };
};

const log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) =>
  logger
    ? logger.log(level, event, fields)
    : console.error(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }));

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

const runPackagedTransportSmoke = async (
  window: BrowserWindow,
  profiles: ProfileStore,
  smoke: PackagedTransportSmoke,
): Promise<void> => {
  const profileId = 'packaged-transport-smoke';
  const tokenA = `propr_it_${randomBytes(32).toString('base64url')}`;
  const tokenB = `propr_it_${randomBytes(32).toString('base64url')}`;
  const profileA = await profiles.save({
    id: profileId, label: 'Packaged transport A', apiBaseUrl: smoke.firstOrigin,
  });
  await profiles.writeCredential({ version: 1, profileId, origin: smoke.firstOrigin, token: tokenA });
  await Promise.all([
    session.defaultSession.cookies.set({
      url: smoke.firstOrigin, name: 'smoke-old-origin', value: 'must-be-cleared',
    }),
    session.defaultSession.cookies.set({
      url: smoke.secondOrigin, name: 'smoke-new-origin', value: 'must-be-cleared',
    }),
  ]);

  const first = await window.webContents.executeJavaScript(`(async () => {
    const bridge = window.proprDesktop;
    if (!bridge) throw new Error('Packaged preload bridge is unavailable');
    const profile = ${JSON.stringify({ id: profileId, label: profileA.label, apiBaseUrl: smoke.firstOrigin })};
    const rest = async (origin, scope) => {
      const response = await fetch(origin + '/api/smoke/rest', {
        credentials: 'include',
        headers: { ${JSON.stringify(DESKTOP_TRANSPORT_SCOPE_HEADER)}: scope },
      });
      if (!response.ok || (await response.json()).ok !== true) throw new Error('Packaged REST fixture failed');
    };
    const socket = (origin, scope) => new Promise((resolveSocket, rejectSocket) => {
      const endpoint = new URL(origin);
      endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
      endpoint.pathname = '/socket.io/';
      endpoint.searchParams.set('EIO', '4');
      endpoint.searchParams.set('transport', 'websocket');
      endpoint.searchParams.set(${JSON.stringify(DESKTOP_TRANSPORT_SCOPE_QUERY)}, scope);
      const connection = new WebSocket(endpoint.href);
      const timeout = setTimeout(() => { connection.close(); rejectSocket(new Error('Packaged socket fixture timed out')); }, 5000);
      connection.onopen = () => { clearTimeout(timeout); connection.close(); resolveSocket(true); };
      connection.onerror = () => { clearTimeout(timeout); rejectSocket(new Error('Packaged socket fixture failed')); };
    });
    const probeA = await bridge.connection.probe(profile);
    if (probeA.status !== 'ready') throw new Error('Packaged A probe was not ready');
    const activatedA = await bridge.connection.activate(probeA.activationTicket);
    await rest(profile.apiBaseUrl, activatedA.transportScope);
    await socket(profile.apiBaseUrl, activatedA.transportScope);
    const reprobeA = await bridge.connection.probe(profile);
    if (reprobeA.status !== 'ready') throw new Error('Packaged A reprobe was not ready');
    const rotatedA = await bridge.connection.activate(reprobeA.activationTicket);
    let staleRestRejected = false;
    try { await rest(profile.apiBaseUrl, activatedA.transportScope); }
    catch { staleRestRejected = true; }
    await rest(profile.apiBaseUrl, rotatedA.transportScope);
    localStorage.setItem('packaged-smoke-local', 'non-secret sentinel');
    sessionStorage.setItem('packaged-smoke-session', 'non-secret sentinel');
    await bridge.profiles.save({
      id: profile.id, label: 'Packaged transport B', apiBaseUrl: ${JSON.stringify(smoke.secondOrigin)},
    });
    return {
      rendererOrigin: location.origin,
      profileId: profile.id,
      firstScope: activatedA.transportScope,
      rotatedScope: rotatedA.transportScope,
      scopesRotated: activatedA.transportScope !== rotatedA.transportScope,
      staleRestRejected,
      activationContainsSecret: JSON.stringify([probeA, activatedA, reprobeA, rotatedA]).includes('propr_it_'),
    };
  })()`);
  if (first?.rendererOrigin !== DESKTOP_RENDERER_ORIGIN || first?.profileId !== profileId
    || first?.scopesRotated !== true || first?.staleRestRejected !== true
    || first?.activationContainsSecret !== false) {
    throw new Error('Packaged renderer protocol or A transport smoke proof failed');
  }

  const cookiesAfterEdit = await Promise.all([
    session.defaultSession.cookies.get({ url: smoke.firstOrigin }),
    session.defaultSession.cookies.get({ url: smoke.secondOrigin }),
  ]);
  if (cookiesAfterEdit.some(cookies => cookies.length !== 0)) {
    throw new Error('Same-ID URL edit did not clear both Electron origin stores');
  }
  await profiles.writeCredential({ version: 1, profileId, origin: smoke.secondOrigin, token: tokenB });

  const second = await window.webContents.executeJavaScript(`(async () => {
    const bridge = window.proprDesktop;
    const profile = ${JSON.stringify({ id: profileId, label: 'Packaged transport B', apiBaseUrl: smoke.secondOrigin })};
    const probeB = await bridge.connection.probe(profile);
    if (probeB.status !== 'ready') throw new Error('Packaged B probe was not ready');
    const activatedB = await bridge.connection.activate(probeB.activationTicket);
    const staleInvalidation = await bridge.connection.invalidate({
      profileId: profile.id,
      transportScope: ${JSON.stringify(first.rotatedScope)},
      code: 'INVALID_INSTANCE_TOKEN',
    });
    const response = await fetch(profile.apiBaseUrl + '/api/smoke/rest', {
      credentials: 'include',
      headers: { ${JSON.stringify(DESKTOP_TRANSPORT_SCOPE_HEADER)}: activatedB.transportScope },
    });
    if (!response.ok || (await response.json()).ok !== true) throw new Error('Packaged B REST fixture failed');
    await new Promise((resolveSocket, rejectSocket) => {
      const endpoint = new URL(profile.apiBaseUrl);
      endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
      endpoint.pathname = '/socket.io/';
      endpoint.searchParams.set('EIO', '4');
      endpoint.searchParams.set('transport', 'websocket');
      endpoint.searchParams.set(${JSON.stringify(DESKTOP_TRANSPORT_SCOPE_QUERY)}, activatedB.transportScope);
      const connection = new WebSocket(endpoint.href);
      const timeout = setTimeout(() => { connection.close(); rejectSocket(new Error('Packaged B socket timed out')); }, 5000);
      connection.onopen = () => { clearTimeout(timeout); connection.close(); resolveSocket(true); };
      connection.onerror = () => { clearTimeout(timeout); rejectSocket(new Error('Packaged B socket failed')); };
    });
    const persisted = await bridge.profiles.list();
    const rendererPersistence = JSON.stringify({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
      profiles: persisted,
    });
    return {
      staleInvalidated: staleInvalidation.invalidated,
      replacementReady: activatedB.profileId === profile.id,
      profileContractContainsSecret: JSON.stringify([probeB, activatedB, persisted]).includes('propr_it_'),
      rendererPersistenceContainsSecret: rendererPersistence.includes('propr_it_'),
    };
  })()`);
  const secretInMainMetadata = [tokenA, tokenB].some(secret =>
    process.argv.some(argument => argument.includes(secret))
    || JSON.stringify(crashReporter.getParameters()).includes(secret));
  if (second?.staleInvalidated !== false || second?.replacementReady !== true
    || second?.profileContractContainsSecret !== false
    || second?.rendererPersistenceContainsSecret !== false
    || secretInMainMetadata) {
    throw new Error('Packaged replacement scope or secret-custody smoke proof failed');
  }
  log('info', 'desktop.renderer.transport_smoke.ready', {
    customProtocol: true,
    restBearer: true,
    socketBearer: true,
    scopeRotation: true,
    bothOriginsCleared: true,
    staleScopeRejected: true,
    secretCustody: true,
  });
};

const createMainWindow = async (
  profiles: ProfileStore,
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
    await window.loadURL(packagedRendererUrl);
  }

  await readyToShow;
  const preloadBridgeExposed = await window.webContents.executeJavaScript(
    "typeof window.proprDesktop === 'object' && window.proprDesktop !== null",
  );
  if (preloadBridgeExposed !== true) {
    throw new Error('Desktop preload bridge was not exposed to the renderer');
  }
  if (transportSmoke) await runPackagedTransportSmoke(window, profiles, transportSmoke);
  log('info', 'desktop.renderer.ready', { preloadBridgeExposed: true });
  if (transportSmoke) {
    app.quit();
  } else {
    window.show();
  }
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
    // The packaged transport fixture is confined to an isolated temp profile,
    // two exact loopback origins, synthetic random credentials, and immediate
    // exit. This exercises the production ProfileStore/service/session path on
    // Linux runners where no login keyring exists without weakening real data.
    const encryption: EncryptionProvider = transportSmoke ? {
      isEncryptionAvailable: () => true,
      backend: () => 'packaged-smoke-fixture',
      encrypt: value => Buffer.from(value, 'utf8'),
      decrypt: value => value.toString('utf8'),
    } : productionEncryption;
    const profiles = new ProfileStore(app.getPath('userData'), encryption);
    const credentials = new DesktopCredentialService({
      profiles,
      fetch: session.defaultSession.fetch.bind(session.defaultSession) as typeof globalThis.fetch,
      openExternal: async url => { await shell.openExternal(url); },
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
      lifecycle,
      logger,
      desktopSession: session.defaultSession,
      devServerUrl,
      packagedRendererUrl,
      openExternal: async url => { await shell.openExternal(url); },
    });
    mainWindow = await createMainWindow(profiles, transportSmoke);
    deepLinkDelivery.setWindow(mainWindow);

    app.on('activate', () => {
      if (shutdownStarted) return;
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow(profiles, null).then(window => {
          mainWindow = window;
          deepLinkDelivery.setWindow(window);
        });
      }
    });

    const shutdown = createDesktopShutdownCoordinator({
      credentials,
      lifecycle,
      ipc: registeredIpc,
      profiles,
      sessionSecurity,
      disposeRendererProtocol,
      getWindow: () => mainWindow,
      quit: () => app.quit(),
      onStarted: () => { shutdownStarted = true; },
      log,
    });
    app.on('before-quit', event => shutdown.beforeQuit(event));
  }).catch(error => {
    log('error', 'desktop.app.start_failed', { error });
    app.exit(1);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

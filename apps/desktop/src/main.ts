import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, net, protocol, safeStorage, session, shell } from 'electron';
import { DESKTOP_RENDERER_ORIGIN } from '@propr/shared';
import { DeepLinkDelivery } from './deep-link-delivery';
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
import { checkForSignedUpdates } from './signed-updates';
import { handleSquirrelStartupEvent } from './squirrel-events';
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
const squirrelStartupHandled = process.platform === 'win32'
  && handleSquirrelStartupEvent({ quit: () => app.quit() });

if (process.platform === 'win32') {
  app.setAppUserModelId('com.squirrel.propr_desktop.propr_desktop');
}

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

const createMainWindow = async (): Promise<BrowserWindow> => {
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
  const smokeProfileApiUrl = process.env.PROPR_DESKTOP_SMOKE_PROFILE_API_URL;
  if (app.isPackaged && process.env.PROPR_DESKTOP_SMOKE_TEST === '1' && smokeProfileApiUrl) {
    const normalizedSmokeApiUrl = normalizeApiBaseUrl(smokeProfileApiUrl);
    if (!normalizedSmokeApiUrl || normalizedSmokeApiUrl !== smokeProfileApiUrl) {
      throw new Error('Packaged desktop smoke profile API URL is invalid');
    }
    const endpoint = `${normalizedSmokeApiUrl}/api/compatibility`;
    const result = await window.webContents.executeJavaScript(`(async () => {
      const response = await fetch(${JSON.stringify(endpoint)}, { credentials: 'include' });
      return { ok: response.ok, status: response.status, body: await response.json() };
    })()`);
    if (result?.ok !== true || result?.body?.profileEndpoint !== true) {
      throw new Error(`Packaged renderer profile API request failed with HTTP ${result?.status ?? 'unknown'}`);
    }
    log('info', 'desktop.renderer.profile_api.ready', { origin: DESKTOP_RENDERER_ORIGIN });
  }
  log('info', 'desktop.renderer.ready', { preloadBridgeExposed: true });
  if (app.isPackaged && process.env.PROPR_DESKTOP_SMOKE_TEST === '1') {
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

const hasSingleInstanceLock = !squirrelStartupHandled && app.requestSingleInstanceLock();
if (squirrelStartupHandled) {
  // The Squirrel event handler owns shortcut maintenance and process exit.
} else if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
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
    });
    mainWindow = await createMainWindow();
    deepLinkDelivery.setWindow(mainWindow);

    const updateConfig = __PROPR_DESKTOP_UPDATE_MANIFEST_URL__
      ? {
          manifestUrl: __PROPR_DESKTOP_UPDATE_MANIFEST_URL__,
          publicKey: __PROPR_DESKTOP_UPDATE_PUBLIC_KEY__,
          signingIdentity: __PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY__,
        }
      : undefined;
    if (app.isPackaged && updateConfig && process.env.PROPR_DESKTOP_SMOKE_TEST !== '1') {
      const runUpdateCheck = () => {
        void checkForSignedUpdates({
          config: updateConfig,
          currentVersion: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          request: (url, init) => net.fetch(url, init),
        }).then(result => log('info', 'desktop.update.check_complete', { result }))
          .catch(error => log('error', 'desktop.update.check_failed', { error }));
      };
      // Squirrel holds an installer lock briefly on Windows first run.
      if (process.platform === 'win32' && process.argv.includes('--squirrel-firstrun')) {
        setTimeout(runUpdateCheck, 10_000);
      } else {
        runUpdateCheck();
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow().then(window => {
          mainWindow = window;
          deepLinkDelivery.setWindow(window);
        });
      }
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
  }).catch(error => {
    log('error', 'desktop.app.start_failed', { error });
    app.exit(1);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

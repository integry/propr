import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, safeStorage, session, shell } from 'electron';
import { registerIpcHandlers } from './ipc';
import { LocalLifecycleController } from './lifecycle';
import { createDesktopLogger, type DesktopLogger } from './logger';
import { ProfileStore, type EncryptionProvider } from './profile-store';
import {
  deepLinkFromArguments,
  isSafeExternalUrl,
  isTrustedRendererUrl,
  normalizeDeepLink,
  rendererContentSecurityPolicy,
  validatedDevServerUrl,
} from './security';
import { DESKTOP_PROTOCOL, IPC_CHANNELS } from './shared/contract';
import { createBrowserWindowOptions } from './window-options';

const devServerUrl = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string'
  ? MAIN_WINDOW_VITE_DEV_SERVER_URL
  : undefined;
const rendererFilePath = join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/renderer.html`);
let mainWindow: BrowserWindow | null = null;
let pendingDeepLink: string | null = deepLinkFromArguments(process.argv);
let logger: DesktopLogger | null = null;
let shutdownStarted = false;

const log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) =>
  logger
    ? logger.log(level, event, fields)
    : console.error(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }));

const registerProtocolClient = (): void => {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL, process.execPath, [process.argv[1]]);
    return;
  }
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL);
};

const deliverDeepLink = (value: string): void => {
  pendingDeepLink = value;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
  mainWindow.webContents.send(IPC_CHANNELS.deepLink, value);
  pendingDeepLink = null;
};

const configureSessionSecurity = (): void => {
  const desktopSession = session.defaultSession;
  desktopSession.setPermissionCheckHandler(() => false);
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  desktopSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [rendererContentSecurityPolicy()],
      },
    });
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
  const window = new BrowserWindow(createBrowserWindowOptions(join(__dirname, 'preload.js'), !app.isPackaged));

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openAllowedExternalUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url, devServerUrl, rendererFilePath)) return;
    event.preventDefault();
    void openAllowedExternalUrl(url);
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, details) => {
    log('error', 'desktop.renderer.gone', { reason: details.reason, exitCode: details.exitCode });
  });
  window.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) {
      window.webContents.send(IPC_CHANNELS.deepLink, pendingDeepLink);
      pendingDeepLink = null;
    }
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  const validatedDevUrl = validatedDevServerUrl(devServerUrl);
  if (devServerUrl && !validatedDevUrl) throw new Error('Electron Forge supplied an unsafe renderer development URL');
  if (validatedDevUrl) {
    await window.loadURL(new URL('renderer.html', validatedDevUrl).href);
  } else {
    await window.loadFile(rendererFilePath);
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
      devServerUrl,
      rendererFilePath,
    });
    mainWindow = await createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow().then(window => { mainWindow = window; });
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

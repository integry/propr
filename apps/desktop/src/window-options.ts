import type { BrowserWindowConstructorOptions } from 'electron';

export const PREFERRED_BROWSER_WINDOW_SIZE = Object.freeze({ width: 1280, height: 820 });
export const MINIMUM_BROWSER_WINDOW_SIZE = Object.freeze({ width: 880, height: 620 });

export const createBrowserWindowOptions = (
  preloadPath: string,
  allowDevTools: boolean,
  platform: NodeJS.Platform = process.platform,
): BrowserWindowConstructorOptions => ({
  title: 'ProPR Desktop',
  width: PREFERRED_BROWSER_WINDOW_SIZE.width,
  height: PREFERRED_BROWSER_WINDOW_SIZE.height,
  minWidth: MINIMUM_BROWSER_WINDOW_SIZE.width,
  minHeight: MINIMUM_BROWSER_WINDOW_SIZE.height,
  backgroundColor: '#f8fafc',
  show: false,
  ...(platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
  webPreferences: {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    devTools: allowDevTools,
  },
});

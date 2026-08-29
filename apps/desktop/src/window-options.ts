import type { BrowserWindowConstructorOptions } from 'electron';

export const createBrowserWindowOptions = (
  preloadPath: string,
  allowDevTools: boolean,
  platform: NodeJS.Platform = process.platform,
): BrowserWindowConstructorOptions => ({
  title: 'ProPR Desktop',
  width: 1280,
  height: 820,
  minWidth: 880,
  minHeight: 620,
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

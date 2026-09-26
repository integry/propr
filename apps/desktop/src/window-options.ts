import type { BrowserWindowConstructorOptions, Display, NativeImage, Point, Rectangle } from 'electron';
import windowSizing from '../window-sizing.json';

export const PREFERRED_BROWSER_WINDOW_SIZE = Object.freeze({ ...windowSizing.preferred });
export const MINIMUM_BROWSER_WINDOW_SIZE = Object.freeze({ ...windowSizing.minimum });
export const DESKTOP_TITLE_BAR_HEIGHT = 44;

type DisplaySelector = {
  getCursorScreenPoint: () => Point;
  getDisplayNearestPoint: (point: Point) => Display;
  getPrimaryDisplay: () => Display;
};

type BrowserWindowSizing = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
};

const hasUsableWorkArea = (workArea: Rectangle): boolean => (
  Number.isInteger(workArea.x)
  && Number.isInteger(workArea.y)
  && Number.isInteger(workArea.width)
  && Number.isInteger(workArea.height)
  && workArea.width > 0
  && workArea.height > 0
);

export const selectInitialWindowWorkArea = (displays: DisplaySelector): Rectangle => {
  const primaryWorkArea = displays.getPrimaryDisplay().workArea;
  if (!hasUsableWorkArea(primaryWorkArea)) {
    throw new Error('Electron primary display reported an invalid work area');
  }

  try {
    const activeWorkArea = displays.getDisplayNearestPoint(displays.getCursorScreenPoint()).workArea;
    return hasUsableWorkArea(activeWorkArea) ? activeWorkArea : primaryWorkArea;
  } catch {
    return primaryWorkArea;
  }
};

export const clampBrowserWindowSizing = (
  workArea: Pick<Rectangle, 'width' | 'height'>,
): BrowserWindowSizing => {
  if (
    !Number.isInteger(workArea.width)
    || !Number.isInteger(workArea.height)
    || workArea.width <= 0
    || workArea.height <= 0
  ) {
    throw new Error('Cannot size the desktop window for an invalid display work area');
  }

  const width = Math.min(PREFERRED_BROWSER_WINDOW_SIZE.width, workArea.width);
  const height = Math.min(PREFERRED_BROWSER_WINDOW_SIZE.height, workArea.height);
  return {
    width,
    height,
    minWidth: Math.min(MINIMUM_BROWSER_WINDOW_SIZE.width, width),
    minHeight: Math.min(MINIMUM_BROWSER_WINDOW_SIZE.height, height),
  };
};

export const createBrowserWindowOptions = (
  preloadPath: string,
  allowDevTools: boolean,
  workArea: Rectangle,
  platform: NodeJS.Platform = process.platform,
  desktopIcon?: NativeImage,
): BrowserWindowConstructorOptions => {
  if (!hasUsableWorkArea(workArea)) {
    throw new Error('Cannot place the desktop window in an invalid display work area');
  }
  if (platform === 'linux' && !desktopIcon) {
    throw new Error('Linux desktop windows require the branded native icon');
  }
  const sizing = clampBrowserWindowSizing(workArea);
  return {
    title: platform === 'darwin' ? 'ProPR' : 'ProPR Desktop',
    ...sizing,
    x: workArea.x + Math.floor((workArea.width - sizing.width) / 2),
    y: workArea.y + Math.floor((workArea.height - sizing.height) / 2),
    backgroundColor: platform === 'linux' || platform === 'darwin' ? '#00000000' : '#f8fafc',
    show: false,
    // Avoid Electron's opaque GTK rim. The renderer paints the Linux edge;
    // Electron 44 retains a native 5px internal resize band for this mode.
    ...(platform === 'linux' ? { icon: desktopIcon, transparent: true } : {}),
    ...(platform === 'darwin'
      ? {
          vibrancy: 'sidebar' as const,
          visualEffectState: 'followWindow' as const,
          titleBarStyle: 'hiddenInset' as const,
          titleBarOverlay: { height: DESKTOP_TITLE_BAR_HEIGHT },
        }
      : platform === 'linux'
        ? {
            frame: false,
            autoHideMenuBar: true,
          }
        : {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: {
              color: '#f8fafc',
              symbolColor: '#475569',
              height: 36,
            },
            autoHideMenuBar: true,
          }),
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
  };
};

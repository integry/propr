export const isDesktopRuntime = (): boolean =>
  typeof __PROPR_DESKTOP__ !== 'undefined' && __PROPR_DESKTOP__;

const desktopLocation = (): URL => {
  const hashPath = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  return new URL(hashPath || '/', 'https://desktop.propr.invalid');
};

export const currentUiPathname = (): string =>
  isDesktopRuntime() ? desktopLocation().pathname : window.location.pathname;

export const navigateToUiPath = (path: string): void => {
  if (isDesktopRuntime()) {
    window.location.hash = path;
    return;
  }
  window.location.href = path;
};

export const publicAssetUrl = (path: `/${string}`): string =>
  isDesktopRuntime() ? new URL(`.${path}`, window.location.href).href : path;

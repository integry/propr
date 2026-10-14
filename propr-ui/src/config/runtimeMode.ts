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

const safeUiUrl = (path: string, base: URL): URL | null => {
  if (
    !path.startsWith('/')
    || path.startsWith('//')
    || path.startsWith('/\\')
    || /[\u0000-\u001F\u007F\\]/.test(path)
  ) return null;

  try {
    const target = new URL(path, base);
    if (
      target.origin !== base.origin
      || (target.protocol !== 'http:' && target.protocol !== 'https:')
    ) return null;
    return target;
  } catch {
    return null;
  }
};

export const navigateToUiPath = (path: string): void => {
  const desktop = isDesktopRuntime();
  const base = desktop
    ? new URL('https://desktop.propr.invalid')
    : new URL(window.location.href);
  const safeUrl = safeUiUrl(path, base);
  if (safeUrl === null) return;

  if (desktop) {
    window.location.hash = `${safeUrl.pathname}${safeUrl.search}${safeUrl.hash}`;
    return;
  }
  window.location.href = safeUrl.href;
};

/** Replace the visible route without notifying the router or remounting the editor. */
export const replaceUiPathInPlace = (path: string): void => {
  const desktop = isDesktopRuntime();
  const safeUrl = safeUiUrl(path, desktop
    ? new URL('https://desktop.propr.invalid')
    : new URL(window.location.href));
  if (safeUrl === null) return;

  const route = `${safeUrl.pathname}${safeUrl.search}${safeUrl.hash}`;
  // Packaged renderer ownership requires the original document pathname. Only
  // its hash is a UI route; location.hash would also notify HashRouter.
  window.history.replaceState(window.history.state, '', desktop ? `#${route}` : route);
};

export const publicAssetUrl = (path: `/${string}`): string =>
  isDesktopRuntime() ? new URL(`.${path}`, window.location.href).href : path;

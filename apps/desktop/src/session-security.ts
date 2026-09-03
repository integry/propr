import type { Session, WebContents } from 'electron';
import type { DesktopCredentialService } from './credential-service';

const DESKTOP_NETWORK_PERMISSIONS = new Set([
  // Chromium split the original permission into address-space-specific
  // permissions. Keep the original spelling for older supported runtimes.
  'local-network-access',
  'local-network',
  'loopback-network',
]);

export type DesktopNetworkPermissionCategory =
  | 'local-network-access'
  | 'local-network'
  | 'loopback-network';

export interface DesktopNetworkPermissionEvidence {
  schemaVersion: 1;
  permissionCategory: DesktopNetworkPermissionCategory;
  decision: 'check' | 'request';
  allowed: boolean;
  activeBindingCurrent: boolean;
  webContentsPresent: boolean;
  webContentsEqualsMainWindow: boolean;
  mainWindowPresent: boolean;
  isMainFrame: boolean;
  requestingUrlPresent: boolean;
  requestingUrlTrusted: boolean;
  rendererDocumentUrlTrusted: boolean;
  requestingOriginAuthorityValid: boolean;
  requestingOriginAuthorityEqual: boolean;
}

export interface DesktopRendererOwnershipEvidence {
  schemaVersion: 1;
  resourceCategory: 'xhr' | 'webSocket' | 'other';
  mainRendererPresent: boolean;
  mainRendererLive: boolean;
  webContentsIdMatches: boolean;
  webContentsAbsentOrMatches: boolean;
  mainFrameLive: boolean;
  rendererDocumentTrusted: boolean;
  rendererDocumentAuthorityEqual: boolean;
  frameOmitted: boolean;
  framePresent: boolean;
  frameMatchesMainFrame: boolean;
  frameExplicitlyForeign: boolean;
  rendererOwned: boolean;
}

const rendererAuthority = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (!url.protocol || !url.hostname || url.username || url.password) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
};

export interface DesktopNetworkPermissionContext extends Omit<DesktopNetworkPermissionEvidence,
  'schemaVersion' | 'permissionCategory' | 'allowed'> {
  permission: string;
  requestingUrlAuthorityEqual: boolean;
}

/** Local Network Access is available only to the live trusted main frame with a current binding. */
export const desktopNetworkPermissionAllowed = ({
  activeBindingCurrent,
  decision,
  isMainFrame,
  mainWindowPresent,
  permission,
  rendererDocumentUrlTrusted,
  requestingOriginAuthorityEqual,
  requestingOriginAuthorityValid,
  requestingUrlAuthorityEqual,
  requestingUrlPresent,
  requestingUrlTrusted,
  webContentsEqualsMainWindow,
  webContentsPresent,
}: DesktopNetworkPermissionContext): boolean => DESKTOP_NETWORK_PERMISSIONS.has(permission)
  && activeBindingCurrent
  && mainWindowPresent
  && isMainFrame
  && rendererDocumentUrlTrusted
  && (!requestingUrlPresent || (requestingUrlTrusted && requestingUrlAuthorityEqual))
  && requestingOriginAuthorityValid
  && requestingOriginAuthorityEqual
  && (decision === 'check'
    ? !webContentsPresent || webContentsEqualsMainWindow
    : webContentsPresent && webContentsEqualsMainWindow && requestingUrlPresent);

interface ConfigureDesktopSessionSecurityOptions {
  contentSecurityPolicy(): string;
  credentials: DesktopCredentialService;
  desktopSession: Session;
  enableRendererNetworkBoundary?: boolean;
  getMainRenderer(): WebContents | null;
  isTrustedRendererUrl(value: string): boolean;
  reportNetworkPermissionDecision?(evidence: DesktopNetworkPermissionEvidence): void;
  reportRendererOwnershipDecision?(evidence: DesktopRendererOwnershipEvidence): void;
}

/** Install the production permission, concrete-request, and response boundary on one session. */
export const configureDesktopSessionSecurity = ({
  contentSecurityPolicy,
  credentials,
  desktopSession,
  enableRendererNetworkBoundary = true,
  getMainRenderer,
  isTrustedRendererUrl,
  reportNetworkPermissionDecision = () => undefined,
  reportRendererOwnershipDecision = () => undefined,
}: ConfigureDesktopSessionSecurityOptions): {
  close(): void;
  dispose(): void;
} => {
  const allowNetworkPermission = (
    decision: 'check' | 'request',
    webContents: WebContents | null,
    permission: string,
    requestingOrigin: string,
    isMainFrame: boolean,
    requestingUrl?: string,
  ): boolean => {
    const candidate = getMainRenderer();
    const mainRenderer = candidate !== null && !candidate.isDestroyed() ? candidate : null;
    const rendererDocumentUrl = mainRenderer?.getURL() ?? '';
    const rendererDocumentAuthority = rendererAuthority(rendererDocumentUrl);
    const requestingUrlPresent = typeof requestingUrl === 'string' && requestingUrl.length > 0;
    const requestingUrlAuthority = requestingUrlPresent ? rendererAuthority(requestingUrl) : null;
    const requestingOriginAuthority = rendererAuthority(requestingOrigin);
    const context: DesktopNetworkPermissionContext = {
      activeBindingCurrent: credentials.hasActiveRendererBinding(),
      decision,
      isMainFrame: isMainFrame === true,
      mainWindowPresent: mainRenderer !== null,
      permission,
      rendererDocumentUrlTrusted: mainRenderer !== null && isTrustedRendererUrl(rendererDocumentUrl),
      requestingOriginAuthorityEqual: rendererDocumentAuthority !== null
        && requestingOriginAuthority === rendererDocumentAuthority,
      requestingOriginAuthorityValid: requestingOriginAuthority !== null
        && requestingOrigin === requestingOriginAuthority,
      requestingUrlAuthorityEqual: !requestingUrlPresent || (rendererDocumentAuthority !== null
        && requestingUrlAuthority === rendererDocumentAuthority),
      requestingUrlPresent,
      requestingUrlTrusted: requestingUrlPresent && isTrustedRendererUrl(requestingUrl),
      webContentsEqualsMainWindow: webContents !== null && webContents === mainRenderer,
      webContentsPresent: webContents !== null,
    };
    const allowed = desktopNetworkPermissionAllowed(context);
    if (DESKTOP_NETWORK_PERMISSIONS.has(permission)) {
      try {
        reportNetworkPermissionDecision({
          schemaVersion: 1,
          permissionCategory: permission as DesktopNetworkPermissionCategory,
          decision,
          allowed,
          activeBindingCurrent: context.activeBindingCurrent,
          webContentsPresent: context.webContentsPresent,
          webContentsEqualsMainWindow: context.webContentsEqualsMainWindow,
          mainWindowPresent: context.mainWindowPresent,
          isMainFrame: context.isMainFrame,
          requestingUrlPresent: context.requestingUrlPresent,
          requestingUrlTrusted: context.requestingUrlTrusted,
          rendererDocumentUrlTrusted: context.rendererDocumentUrlTrusted,
          requestingOriginAuthorityValid: context.requestingOriginAuthorityValid,
          requestingOriginAuthorityEqual: context.requestingOriginAuthorityEqual,
        });
      } catch {
        // Fixed diagnostics cannot alter the permission decision.
      }
    }
    return allowed;
  };

  if (enableRendererNetworkBoundary) {
    desktopSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
      allowNetworkPermission(
        'check',
        webContents,
        String(permission),
        requestingOrigin,
        details.isMainFrame,
        details.requestingUrl,
      ));
    desktopSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const requestingUrl = 'requestingUrl' in details && typeof details.requestingUrl === 'string'
        ? details.requestingUrl
        : undefined;
      callback(allowNetworkPermission(
        'request',
        webContents,
        String(permission),
        requestingUrl ? rendererAuthority(requestingUrl) ?? '' : '',
        details.isMainFrame,
        requestingUrl,
      ));
    });
  } else {
    desktopSession.setPermissionCheckHandler(() => false);
    desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  }
  desktopSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const mainRenderer = getMainRenderer();
    const requestingFrame = details.frame;
    const mainFrame = mainRenderer?.mainFrame;
    const mainRendererLive = mainRenderer !== null && !mainRenderer.isDestroyed();
    const mainFrameLive = mainRendererLive
      && mainFrame !== undefined
      && mainFrame !== null
      && !mainFrame.detached
      && mainFrame.parent === null;
    const rendererDocumentUrl = mainRendererLive ? mainRenderer.getURL() : '';
    const mainFrameUrl = mainFrameLive ? mainFrame.url : '';
    const rendererDocumentTrusted = mainFrameLive
      && isTrustedRendererUrl(rendererDocumentUrl)
      && isTrustedRendererUrl(mainFrameUrl);
    const rendererDocumentAuthorityEqual = rendererDocumentTrusted
      && rendererAuthority(rendererDocumentUrl) !== null
      && rendererAuthority(rendererDocumentUrl) === rendererAuthority(mainFrameUrl)
      && rendererDocumentUrl === mainFrameUrl;
    const webContentsIdMatches = mainRendererLive && details.webContentsId === mainRenderer.id;
    const webContentsAbsentOrMatches = mainRendererLive
      && (details.webContents === undefined || details.webContents === mainRenderer);
    const frameOmitted = requestingFrame === undefined;
    const framePresent = requestingFrame !== undefined && requestingFrame !== null;
    const frameMatchesMainFrame = framePresent
      && mainFrame !== undefined
      && mainFrame !== null
      && requestingFrame === mainFrame
      && !requestingFrame.detached
      && isTrustedRendererUrl(requestingFrame.url);
    const resourceCategory = details.resourceType === 'xhr'
      ? 'xhr'
      : details.resourceType === 'webSocket'
        ? 'webSocket'
        : 'other';
    const rendererOwned = mainRendererLive
      && webContentsIdMatches
      && webContentsAbsentOrMatches
      && frameMatchesMainFrame;
    if (details.webContentsId !== undefined) {
      try {
        reportRendererOwnershipDecision({
          schemaVersion: 1,
          resourceCategory,
          mainRendererPresent: mainRenderer !== null,
          mainRendererLive,
          webContentsIdMatches,
          webContentsAbsentOrMatches,
          mainFrameLive,
          rendererDocumentTrusted,
          rendererDocumentAuthorityEqual,
          frameOmitted,
          framePresent,
          frameMatchesMainFrame,
          frameExplicitlyForeign: framePresent && !frameMatchesMainFrame,
          rendererOwned,
        });
      } catch {
        // Fixed diagnostics cannot alter the renderer ownership decision.
      }
    }
    void credentials.prepareRequestAsync(details.url, details.requestHeaders, {
      method: details.method,
      ...(enableRendererNetworkBoundary ? { rendererOwned } : {}),
      resourceType: details.resourceType,
    }).then(callback, () => callback({ cancel: true }));
  });
  desktopSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...credentials.sanitizeResponseHeaders(details.url, details.responseHeaders ?? {}),
        'Content-Security-Policy': [contentSecurityPolicy()],
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

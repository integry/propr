import type { Session, WebContents } from 'electron';
import type { DesktopCredentialService } from './credential-service';

const DESKTOP_NETWORK_PERMISSIONS = new Set([
  // Chromium 145 split the original permission into address-space-specific
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

/**
 * Chromium may require Local Network Access before a renderer request reaches
 * webRequest. This grant authenticates only the packaged application's current
 * main renderer and only while main owns a current credential binding. The
 * credential service still authorizes every concrete URL, scope, and header.
 */
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
  getMainRenderer(): WebContents | null;
  isTrustedRendererUrl(value: string): boolean;
  reportNetworkPermissionDecision?(evidence: DesktopNetworkPermissionEvidence): void;
}

/** Install the production permission, request, and response boundary on one session. */
export const configureDesktopSessionSecurity = ({
  contentSecurityPolicy,
  credentials,
  desktopSession,
  getMainRenderer,
  isTrustedRendererUrl,
  reportNetworkPermissionDecision = () => undefined,
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
    const mainRenderer = getMainRenderer();
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
        // Diagnostics cannot change the permission decision.
      }
    }
    return allowed;
  };

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
  desktopSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const mainRenderer = getMainRenderer();
    const rendererOwned = mainRenderer !== null
      && !mainRenderer.isDestroyed()
      && details.webContentsId === mainRenderer.id;
    callback(credentials.prepareRequest(details.url, details.requestHeaders, {
      method: details.method,
      rendererOwned,
      resourceType: details.resourceType,
    }));
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

import type { Session, WebContents } from 'electron';
import type { DesktopCredentialService } from './credential-service';

const DESKTOP_NETWORK_PERMISSIONS = new Set([
  // Chromium 145 split the original permission into address-space-specific
  // permissions. Keep the original spelling for older supported runtimes.
  'local-network-access',
  'local-network',
  'loopback-network',
]);

const rendererAuthority = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (!url.protocol || !url.hostname || url.username || url.password) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
};

export interface DesktopNetworkPermissionContext {
  activeBindingPresent: boolean;
  permission: string;
  rendererDocumentUrl: string;
  rendererDocumentTrusted: boolean;
  rendererMainFrame: boolean;
  rendererMatchesMainWindow: boolean;
  requestingOrigin: string;
}

/**
 * Chromium may require Local Network Access before a renderer request reaches
 * webRequest. This grant authenticates only the packaged application's current
 * main renderer and only while main owns a current credential binding. The
 * credential service still authorizes every concrete URL, scope, and header.
 */
export const desktopNetworkPermissionAllowed = ({
  activeBindingPresent,
  permission,
  rendererDocumentUrl,
  rendererDocumentTrusted,
  rendererMainFrame,
  rendererMatchesMainWindow,
  requestingOrigin,
}: DesktopNetworkPermissionContext): boolean => DESKTOP_NETWORK_PERMISSIONS.has(permission)
  && activeBindingPresent
  && rendererMainFrame
  && rendererMatchesMainWindow
  && rendererDocumentTrusted
  && rendererAuthority(rendererDocumentUrl) !== null
  && rendererAuthority(rendererDocumentUrl) === rendererAuthority(requestingOrigin);

interface ConfigureDesktopSessionSecurityOptions {
  contentSecurityPolicy(): string;
  credentials: DesktopCredentialService;
  desktopSession: Session;
  getMainRenderer(): WebContents | null;
  isTrustedRendererUrl(value: string): boolean;
}

/** Install the production permission, request, and response boundary on one session. */
export const configureDesktopSessionSecurity = ({
  contentSecurityPolicy,
  credentials,
  desktopSession,
  getMainRenderer,
  isTrustedRendererUrl,
}: ConfigureDesktopSessionSecurityOptions): {
  close(): void;
  dispose(): void;
} => {
  const allowNetworkPermission = (
    webContents: WebContents | null,
    permission: string,
    requestingOrigin: string,
    rendererMainFrame: boolean,
    requestingUrl?: string,
  ): boolean => {
    const mainRenderer = getMainRenderer();
    const rendererDocumentUrl = requestingUrl || webContents?.getURL() || '';
    return desktopNetworkPermissionAllowed({
      activeBindingPresent: credentials.hasActiveRendererBinding(),
      permission,
      rendererDocumentUrl,
      rendererDocumentTrusted: isTrustedRendererUrl(rendererDocumentUrl),
      rendererMainFrame,
      rendererMatchesMainWindow: webContents !== null && webContents === mainRenderer,
      requestingOrigin,
    });
  };

  desktopSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    allowNetworkPermission(
      webContents,
      String(permission),
      requestingOrigin,
      details.isMainFrame,
      details.requestingUrl,
    ));
  desktopSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const rendererUrl = 'requestingUrl' in details && typeof details.requestingUrl === 'string'
      ? details.requestingUrl
      : webContents.getURL();
    callback(allowNetworkPermission(
      webContents,
      String(permission),
      rendererAuthority(rendererUrl) ?? '',
      details.isMainFrame,
      rendererUrl,
    ));
  });
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

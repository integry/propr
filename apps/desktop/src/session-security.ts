import type { IpcMain, IpcMainInvokeEvent, Session, WebContents } from 'electron';
import type { DesktopCredentialService } from './credential-service';
import { IPC_CHANNELS } from './shared/contract';

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

const expectedPackagedConnectOwnership = (
  evidence: DesktopRendererOwnershipEvidence,
): boolean => evidence.mainRendererPresent
  && evidence.mainRendererLive
  && evidence.webContentsIdMatches
  && evidence.webContentsAbsentOrMatches
  && evidence.mainFrameLive
  && evidence.rendererDocumentTrusted
  && evidence.rendererDocumentAuthorityEqual
  && !evidence.frameOmitted
  && evidence.framePresent
  && evidence.frameMatchesMainFrame
  && !evidence.frameExplicitlyForeign
  && evidence.rendererOwned;

/**
 * Keep one proof for each expected request category during the packaged Connect
 * journey. Every unexpected ownership decision remains individually visible.
 */
export const createPackagedConnectOwnershipReporter = (
  report: (evidence: DesktopRendererOwnershipEvidence) => void,
): ((evidence: DesktopRendererOwnershipEvidence) => void) => {
  const reportedExpectedCategories = new Set<DesktopRendererOwnershipEvidence['resourceCategory']>();
  return evidence => {
    if (expectedPackagedConnectOwnership(evidence)) {
      if (reportedExpectedCategories.has(evidence.resourceCategory)) return;
      reportedExpectedCategories.add(evidence.resourceCategory);
    }
    report(evidence);
  };
};

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
  ipcMain?: Pick<IpcMain, 'handle' | 'removeHandler'>;
  requestMicrophoneConsent?(renderer: WebContents, signal: AbortSignal): Promise<boolean>;
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
  ipcMain,
  requestMicrophoneConsent,
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
  let closed = false;
  let microphone: {
    renderer: WebContents;
    document: string;
    frame: WebContents['mainFrame'];
    scope: NonNullable<ReturnType<DesktopCredentialService['activeConnectionScope']>>;
    controller: AbortController;
    allowed: boolean;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const revokeMicrophone = () => {
    const previous = microphone;
    microphone = null;
    if (!previous) return;
    clearTimeout(previous.timer);
    previous.renderer.removeListener('did-start-navigation', revokeMicrophone);
    previous.renderer.removeListener('destroyed', revokeMicrophone);
    previous.renderer.removeListener('render-process-gone', revokeMicrophone);
    previous.controller.abort();
  };
  const trustedMicrophoneSender = (event: IpcMainInvokeEvent): boolean => {
    const renderer = getMainRenderer();
    return !closed && enableRendererNetworkBoundary && renderer !== null
      && !renderer.isDestroyed() && event.sender === renderer
      && event.senderFrame === renderer.mainFrame && !renderer.mainFrame.detached
      && renderer.mainFrame.parent === null
      && isTrustedRendererUrl(renderer.getURL())
      && renderer.mainFrame.url === renderer.getURL();
  };
  const currentMicrophone = (): boolean => {
    const grant = microphone;
    return grant !== null && !closed && !grant.controller.signal.aborted
      && grant.renderer === getMainRenderer() && !grant.renderer.isDestroyed()
      && grant.renderer.getURL() === grant.document
      && grant.renderer.mainFrame === grant.frame && !grant.frame.detached
      && grant.frame.url === grant.document && isTrustedRendererUrl(grant.document)
      && credentials.isActiveConnectionScope(grant.scope);
  };
  ipcMain?.handle(IPC_CHANNELS.microphoneRequest, async event => {
    if (!trustedMicrophoneSender(event) || !event.sender.isFocused()
      || !requestMicrophoneConsent || microphone !== null) return false;
    const scope = credentials.activeConnectionScope();
    if (!scope) return false;
    const renderer = event.sender;
    const controller = new AbortController();
    const attempt = {
      renderer, document: renderer.getURL(), frame: renderer.mainFrame, scope,
      controller, allowed: false,
      timer: setTimeout(revokeMicrophone, 30_000),
    };
    microphone = attempt;
    renderer.once('did-start-navigation', revokeMicrophone);
    renderer.once('destroyed', revokeMicrophone);
    renderer.once('render-process-gone', revokeMicrophone);
    try {
      const allowed = await requestMicrophoneConsent(renderer, controller.signal);
      if (microphone !== attempt) return false;
      if (!allowed || !currentMicrophone()) {
        revokeMicrophone();
        return false;
      }
      attempt.allowed = true;
      return true;
    } catch {
      if (microphone === attempt) revokeMicrophone();
      return false;
    }
  });
  ipcMain?.handle(IPC_CHANNELS.microphoneRevoke, event => {
    if (trustedMicrophoneSender(event)) revokeMicrophone();
  });
  const allowMicrophone = (
    renderer: WebContents | null, origin: string, isMainFrame: boolean,
    requestingUrl: string | undefined, audioOnly: boolean,
  ): boolean => audioOnly && isMainFrame === true && currentMicrophone()
    && microphone?.allowed === true && renderer === microphone.renderer
    && origin === rendererAuthority(microphone.document)
    && (requestingUrl === undefined || requestingUrl === microphone.document);

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
      permission === 'media'
        ? allowMicrophone(webContents, requestingOrigin, details.isMainFrame,
          details.requestingUrl, details.mediaType === 'audio')
        : allowNetworkPermission(
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
      if (permission === 'media') {
        const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
        callback(allowMicrophone(webContents, requestingUrl ? rendererAuthority(requestingUrl) ?? '' : '',
          details.isMainFrame, requestingUrl,
          Array.isArray(mediaTypes) && mediaTypes.length === 1 && mediaTypes[0] === 'audio'));
        return;
      }
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
      closed = true;
      revokeMicrophone();
      desktopSession.webRequest.onBeforeSendHeaders((_details, callback) => callback({ cancel: true }));
      desktopSession.webRequest.onHeadersReceived((_details, callback) => callback({ cancel: true }));
    },
    dispose() {
      closed = true;
      revokeMicrophone();
      ipcMain?.removeHandler(IPC_CHANNELS.microphoneRequest);
      ipcMain?.removeHandler(IPC_CHANNELS.microphoneRevoke);
      desktopSession.setPermissionCheckHandler(() => false);
      desktopSession.setPermissionRequestHandler((_renderer, _permission, callback) => callback(false));
      desktopSession.webRequest.onBeforeSendHeaders(null);
      desktopSession.webRequest.onHeadersReceived(null);
    },
  };
};

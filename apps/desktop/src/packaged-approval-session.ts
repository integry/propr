import type {
  BrowserWindow,
  Event as ElectronEvent,
  OnBeforeRedirectListenerDetails,
  OnBeforeRequestListenerDetails,
  OnBeforeSendHeadersListenerDetails,
  OnCompletedListenerDetails,
  OnHeadersReceivedListenerDetails,
  OnSendHeadersListenerDetails,
  Session,
  WebContentsWillNavigateEventParams,
  WebContentsWillRedirectEventParams,
} from 'electron';

const APPROVAL_REJECTED = 'Packaged pairing browser approval was rejected';
const APPROVAL_CLEANUP_REJECTED = 'Packaged pairing browser approval cleanup failed';
const APPROVAL_STATUS = 200;
const APPROVAL_COMPLETION_TIMEOUT_MS = 5_000;
const APPROVAL_CLEANUP_TIMEOUT_MS = 5_000;
const claimedSessions = new WeakSet<Session>();

export const packagedApprovalPartition = (nonce: string): string => {
  if (!/^[a-f0-9]{32}$/u.test(nonce)) throw rejected();
  return `propr-packaged-approval-${nonce}`;
};

export interface PackagedApprovalNavigation {
  navigate(): Promise<void>;
  cleanup(): Promise<void>;
}

interface PackagedApprovalNavigationOptions {
  approvalUrl: string;
  approvalSession: Session;
  approvalWindow: BrowserWindow;
  defaultSession: Session;
}

function rejected(): Error {
  return new Error(APPROVAL_REJECTED);
}

function cleanupRejected(): Error {
  return new Error(APPROVAL_CLEANUP_REJECTED);
}

export const clearPackagedApprovalStorage = async (
  approvalSession: Pick<Session, 'clearStorageData'>,
  timeoutMs = APPROVAL_CLEANUP_TIMEOUT_MS,
): Promise<void> => {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > APPROVAL_CLEANUP_TIMEOUT_MS) {
    throw cleanupRejected();
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      approvalSession.clearStorageData(),
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => reject(cleanupRejected()), timeoutMs);
      }),
    ]);
  } catch {
    throw cleanupRejected();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const containsCredentialHeaders = (headers: Record<string, string>): boolean =>
  Object.keys(headers).some(name => {
    const normalized = name.toLowerCase();
    return normalized === 'authorization' || normalized === 'cookie' || normalized === 'proxy-authorization';
  });

const withoutSetCookie = (
  headers: Record<string, string[]> | undefined,
): Record<string, string[]> => Object.fromEntries(
  Object.entries(headers ?? {}).filter(([name]) => {
    const normalized = name.toLowerCase();
    return normalized !== 'set-cookie' && normalized !== 'set-cookie2';
  }),
);

/**
 * Constrain the packaged acceptance harness to one isolated, credentialless browser
 * navigation. This session is deliberately unrelated to the production renderer
 * and credential transport session.
 */
export const createPackagedApprovalNavigation = ({
  approvalUrl,
  approvalSession,
  approvalWindow,
  defaultSession,
}: PackagedApprovalNavigationOptions): PackagedApprovalNavigation => {
  const contents = approvalWindow.webContents;
  if (approvalSession === defaultSession
    || contents.session !== approvalSession
    || claimedSessions.has(approvalSession)) {
    throw rejected();
  }
  claimedSessions.add(approvalSession);

  let active = true;
  let navigated = false;
  let allowedRequestId: number | null = null;
  let responseStatus: number | null = null;
  let requestSent = false;
  let committedStatus: number | null = null;
  let committedUrl: string | null = null;
  let completedStatus: number | null = null;
  let boundaryRejected = false;
  let completionResolve: (() => void) | null = null;
  let cleanupPromise: Promise<void> | null = null;

  const releaseCompletionWait = (): void => {
    completionResolve?.();
    completionResolve = null;
  };
  const rejectBoundary = (): void => {
    boundaryRejected = true;
    releaseCompletionWait();
  };
  const ownsMainFrame = (details: {
    webContentsId?: number;
    webContents?: Electron.WebContents;
    frame?: Electron.WebFrameMain | null;
    resourceType: string;
  }): boolean => details.webContentsId === contents.id
    && (details.webContents === undefined || details.webContents === contents)
    && details.resourceType === 'mainFrame'
    && (details.frame === undefined || details.frame === contents.mainFrame);

  const exactAllowedRequest = (details: {
    id: number;
    url: string;
    method: string;
    webContentsId?: number;
    webContents?: Electron.WebContents;
    frame?: Electron.WebFrameMain | null;
    resourceType: string;
  }): boolean => active
    && details.id === allowedRequestId
    && details.url === approvalUrl
    && details.method === 'GET'
    && ownsMainFrame(details);

  approvalSession.setPermissionCheckHandler(() => false);
  approvalSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  const onBeforeRequest = (details: OnBeforeRequestListenerDetails, callback: (decision: {
    cancel?: boolean;
  }) => void): void => {
    if (details.resourceType !== 'mainFrame') {
      if (details.resourceType === 'subFrame') rejectBoundary();
      callback({ cancel: true });
      return;
    }
    const allowed = active
      && allowedRequestId === null
      && details.url === approvalUrl
      && details.method === 'GET'
      && ownsMainFrame(details);
    if (!allowed) {
      rejectBoundary();
      callback({ cancel: true });
      return;
    }
    allowedRequestId = details.id;
    callback({});
  };

  const onBeforeSendHeaders = (
    details: OnBeforeSendHeadersListenerDetails,
    callback: (decision: { cancel?: boolean; requestHeaders?: Record<string, string> }) => void,
  ): void => {
    if (!exactAllowedRequest(details) || containsCredentialHeaders(details.requestHeaders)) {
      rejectBoundary();
      callback({ cancel: true });
      return;
    }
    callback({ requestHeaders: details.requestHeaders });
  };

  const onHeadersReceived = (
    details: OnHeadersReceivedListenerDetails,
    callback: (decision: { cancel?: boolean; responseHeaders?: Record<string, string[]> }) => void,
  ): void => {
    if (!exactAllowedRequest(details) || details.statusCode !== APPROVAL_STATUS) {
      rejectBoundary();
      callback({ cancel: true });
      return;
    }
    responseStatus = details.statusCode;
    callback({ responseHeaders: withoutSetCookie(details.responseHeaders) });
  };

  const onSendHeaders = (details: OnSendHeadersListenerDetails): void => {
    if (!exactAllowedRequest(details) || containsCredentialHeaders(details.requestHeaders)) {
      rejectBoundary();
      return;
    }
    requestSent = true;
  };

  const onBeforeRedirect = (_details: OnBeforeRedirectListenerDetails): void => {
    rejectBoundary();
  };
  const onCompleted = (details: OnCompletedListenerDetails): void => {
    if (!exactAllowedRequest(details) || details.statusCode !== responseStatus) {
      rejectBoundary();
      return;
    }
    completedStatus = details.statusCode;
    releaseCompletionWait();
  };
  approvalSession.webRequest.onBeforeRequest(onBeforeRequest);
  approvalSession.webRequest.onBeforeSendHeaders(onBeforeSendHeaders);
  approvalSession.webRequest.onSendHeaders(onSendHeaders);
  approvalSession.webRequest.onHeadersReceived(onHeadersReceived);
  approvalSession.webRequest.onBeforeRedirect(onBeforeRedirect);
  approvalSession.webRequest.onCompleted(onCompleted);

  const onWillNavigate = (event: ElectronEvent<WebContentsWillNavigateEventParams>): void => {
    rejectBoundary();
    event.preventDefault();
  };
  const onWillRedirect = (event: ElectronEvent<WebContentsWillRedirectEventParams>): void => {
    rejectBoundary();
    event.preventDefault();
  };
  const onDidFrameNavigate = (
    _event: ElectronEvent,
    url: string,
    status: number,
    _statusText: string,
    isMainFrame: boolean,
  ): void => {
    if (!isMainFrame || url !== approvalUrl || status !== responseStatus) {
      rejectBoundary();
      return;
    }
    committedUrl = url;
    committedStatus = status;
  };
  const onDidNavigateInPage = (
    _event: ElectronEvent,
    url: string,
    isMainFrame: boolean,
  ): void => {
    // An exact no-op history replacement is the only same-document behavior allowed.
    if (!isMainFrame || url !== approvalUrl) rejectBoundary();
  };
  const onWillAttachWebview = (event: ElectronEvent): void => {
    rejectBoundary();
    event.preventDefault();
  };
  const onWillDownload = (event: ElectronEvent): void => {
    rejectBoundary();
    event.preventDefault();
  };

  contents.setWindowOpenHandler(() => {
    rejectBoundary();
    return { action: 'deny' };
  });
  contents.on('will-navigate', onWillNavigate);
  contents.on('will-redirect', onWillRedirect);
  contents.on('did-frame-navigate', onDidFrameNavigate);
  contents.on('did-navigate-in-page', onDidNavigateInPage);
  contents.on('will-attach-webview', onWillAttachWebview);
  approvalSession.on('will-download', onWillDownload);

  return {
    async navigate() {
      if (!active || navigated) throw rejected();
      navigated = true;
      const completion = completedStatus !== null || boundaryRejected
        ? Promise.resolve()
        : new Promise<void>(resolve => { completionResolve = resolve; });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await approvalWindow.loadURL(approvalUrl);
            await completion;
          })(),
          new Promise<void>((_resolve, reject) => {
            timeout = setTimeout(() => reject(rejected()), APPROVAL_COMPLETION_TIMEOUT_MS);
          }),
        ]);
      } catch {
        throw rejected();
      } finally {
        if (timeout) clearTimeout(timeout);
        completionResolve = null;
      }
      if (!active
        || boundaryRejected
        || allowedRequestId === null
        || !requestSent
        || responseStatus === null
        || responseStatus !== committedStatus
        || responseStatus !== completedStatus
        || committedUrl !== approvalUrl
        || contents.getURL() !== approvalUrl) {
        throw rejected();
      }
    },
    cleanup() {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        active = false;
        releaseCompletionWait();
        if (!approvalWindow.isDestroyed()) approvalWindow.destroy();
        contents.off('will-navigate', onWillNavigate);
        contents.off('will-redirect', onWillRedirect);
        contents.off('did-frame-navigate', onDidFrameNavigate);
        contents.off('did-navigate-in-page', onDidNavigateInPage);
        contents.off('will-attach-webview', onWillAttachWebview);
        approvalSession.off('will-download', onWillDownload);
        approvalSession.setPermissionCheckHandler(null);
        approvalSession.setPermissionRequestHandler(null);
        approvalSession.webRequest.onBeforeRequest(null);
        approvalSession.webRequest.onBeforeSendHeaders(null);
        approvalSession.webRequest.onSendHeaders(null);
        approvalSession.webRequest.onHeadersReceived(null);
        approvalSession.webRequest.onBeforeRedirect(null);
        approvalSession.webRequest.onCompleted(null);
        await clearPackagedApprovalStorage(approvalSession);
      })();
      return cleanupPromise;
    },
  };
};

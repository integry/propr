import type { IpcMainInvokeEvent, IpcMainEvent, WebContents } from 'electron';

export const PACKAGED_ACCEPTANCE_ZOOM_AUTH_CHANNEL = 'desktop:packaged-acceptance-zoom-authorize';
export const PACKAGED_ACCEPTANCE_ZOOM_APPLY_CHANNEL = 'desktop:packaged-acceptance-zoom-apply';
export const PACKAGED_ACCEPTANCE_ZOOM_MECHANISM = 'electron-web-frame';
export const PACKAGED_ACCEPTANCE_ZOOM_FACTORS = Object.freeze([1, 2] as const);

export type PackagedAcceptanceZoomFactor = typeof PACKAGED_ACCEPTANCE_ZOOM_FACTORS[number];

type ZoomAuthorizationRequest = { protocolVersion: 1 };
type ZoomAuthorizationAcknowledgement = { authorized: true; protocolVersion: 1 };
type ZoomApplyAcknowledgement = { authorized: true; requestedFactor: PackagedAcceptanceZoomFactor };

type IpcMainLike = {
  on(channel: string, listener: (event: IpcMainEvent, request: unknown) => void): void;
  removeListener(channel: string, listener: (event: IpcMainEvent, request: unknown) => void): void;
  handle(channel: string, listener: (event: IpcMainInvokeEvent, factor: unknown) => unknown): void;
  removeHandler(channel: string): void;
};

export type PackagedAcceptancePreloadIpc = {
  sendSync(channel: string, request: unknown): unknown;
  invoke(channel: string, factor: unknown): Promise<unknown>;
};

export type PackagedAcceptanceWebFrame = {
  setZoomFactor(factor: number): void;
  getZoomFactor(): number;
};

export type PackagedAcceptanceZoomResult = {
  requestedFactor: PackagedAcceptanceZoomFactor;
  resetFactor: 1;
  appliedFactor: PackagedAcceptanceZoomFactor;
  mechanism: typeof PACKAGED_ACCEPTANCE_ZOOM_MECHANISM;
};

const exactKeys = (value: object, expected: string[]): boolean => (
  Object.keys(value).sort().join('\n') === [...expected].sort().join('\n')
);

const isAuthorizationRequest = (value: unknown): value is ZoomAuthorizationRequest => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && exactKeys(value, ['protocolVersion'])
  && (value as ZoomAuthorizationRequest).protocolVersion === 1
);

const isAuthorizationAcknowledgement = (value: unknown): value is ZoomAuthorizationAcknowledgement => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && exactKeys(value, ['authorized', 'protocolVersion'])
  && (value as ZoomAuthorizationAcknowledgement).authorized === true
  && (value as ZoomAuthorizationAcknowledgement).protocolVersion === 1
);

const isApplyAcknowledgement = (
  value: unknown,
  requestedFactor: PackagedAcceptanceZoomFactor,
): value is ZoomApplyAcknowledgement => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && exactKeys(value, ['authorized', 'requestedFactor'])
  && (value as ZoomApplyAcknowledgement).authorized === true
  && (value as ZoomApplyAcknowledgement).requestedFactor === requestedFactor
);

export const isPackagedAcceptanceZoomFactor = (value: unknown): value is PackagedAcceptanceZoomFactor => (
  value === 1 || value === 2
);

const preloadHasAcceptanceTriggers = (
  argv: readonly string[],
  environmentValue: string | undefined,
): boolean => argv.includes('--propr-acceptance-test') && environmentValue === '1';

/**
 * Register the two fixed authorization routes only after the main process has
 * completed packaged-acceptance authorization, and bind them to one renderer.
 */
export const registerPackagedAcceptanceZoomIpc = ({
  authorized,
  ipcMain,
  webContents,
}: {
  authorized: boolean;
  ipcMain: IpcMainLike;
  webContents: WebContents;
}): (() => void) => {
  if (!authorized) return () => undefined;

  const trustedSender = (sender: WebContents): boolean => sender === webContents && !webContents.isDestroyed();
  const authorize = (event: IpcMainEvent, request: unknown): void => {
    if (!trustedSender(event.sender) || !isAuthorizationRequest(request)) {
      event.returnValue = null;
      return;
    }
    event.returnValue = { authorized: true, protocolVersion: 1 } satisfies ZoomAuthorizationAcknowledgement;
  };
  ipcMain.on(PACKAGED_ACCEPTANCE_ZOOM_AUTH_CHANNEL, authorize);
  ipcMain.handle(PACKAGED_ACCEPTANCE_ZOOM_APPLY_CHANNEL, (event, factor) => {
    if (!trustedSender(event.sender)) throw new Error('Packaged acceptance zoom sender is not authorized');
    if (!isPackagedAcceptanceZoomFactor(factor)) throw new Error('Packaged acceptance zoom factor is not allowlisted');
    return { authorized: true, requestedFactor: factor } satisfies ZoomApplyAcknowledgement;
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeListener(PACKAGED_ACCEPTANCE_ZOOM_AUTH_CHANNEL, authorize);
    ipcMain.removeHandler(PACKAGED_ACCEPTANCE_ZOOM_APPLY_CHANNEL);
  };
};

/** Build the only acceptance-only renderer capability after a synchronous main-process attestation. */
export const createPackagedAcceptanceZoomBridge = (
  ipc: PackagedAcceptancePreloadIpc,
  frame: PackagedAcceptanceWebFrame,
  argv: readonly string[] = process.argv,
  environmentValue: string | undefined = process.env.PROPR_DESKTOP_ACCEPTANCE_TEST,
): Readonly<{ setZoomFactor(factor: PackagedAcceptanceZoomFactor): Promise<PackagedAcceptanceZoomResult> }> | null => {
  if (!preloadHasAcceptanceTriggers(argv, environmentValue)) return null;
  const authorization = ipc.sendSync(PACKAGED_ACCEPTANCE_ZOOM_AUTH_CHANNEL, { protocolVersion: 1 });
  if (!isAuthorizationAcknowledgement(authorization)) return null;

  return Object.freeze({
    async setZoomFactor(factor: PackagedAcceptanceZoomFactor): Promise<PackagedAcceptanceZoomResult> {
      if (!isPackagedAcceptanceZoomFactor(factor)) throw new Error('Packaged acceptance zoom factor is not allowlisted');
      const acknowledgement = await ipc.invoke(PACKAGED_ACCEPTANCE_ZOOM_APPLY_CHANNEL, factor);
      if (!isApplyAcknowledgement(acknowledgement, factor)) {
        throw new Error('Packaged acceptance zoom authorization acknowledgement is malformed');
      }

      frame.setZoomFactor(1);
      const resetFactor = frame.getZoomFactor();
      if (resetFactor !== 1) throw new Error(`Packaged acceptance zoom reset failed: received ${resetFactor}`);
      frame.setZoomFactor(factor);
      const appliedFactor = frame.getZoomFactor();
      if (appliedFactor !== factor) {
        throw new Error(`Packaged acceptance zoom application failed: expected ${factor}, received ${appliedFactor}`);
      }
      return {
        requestedFactor: factor,
        resetFactor: 1,
        appliedFactor: factor,
        mechanism: PACKAGED_ACCEPTANCE_ZOOM_MECHANISM,
      };
    },
  });
};

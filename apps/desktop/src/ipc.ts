import type { App, IpcMain, IpcMainInvokeEvent, Session } from 'electron';
import { clearDesktopInstanceCookies, logoutDesktopSession } from './desktop-session';
import type { DesktopCredentialService } from './credential-service';
import type { DesktopConnectDiscoveryService } from './connect-discovery';
import type { DesktopLogger } from './logger';
import type { LocalLifecycleController } from './lifecycle';
import type { ProfileStore } from './profile-store';
import { isSafeExternalUrl, isTrustedRendererUrl } from './security';
import { IPC_CHANNELS } from './shared/contract';
import type { DesktopAcceptanceJourneyStage } from './shared/contract';

export type DesktopAcceptanceOperation = 'PROFILE_SAVE' | 'PAIR' | 'PROBE' | 'ACTIVATE';
export type DesktopAcceptanceOperationStatus =
  | 'COMPLETED'
  | 'READY'
  | 'AUTHENTICATION_REQUIRED'
  | 'INCOMPATIBLE'
  | 'OFFLINE'
  | 'REJECTED';

interface RegisterIpcOptions {
  app: App;
  ipcMain: IpcMain;
  profiles: ProfileStore;
  credentials: DesktopCredentialService;
  connectDiscovery: Pick<DesktopConnectDiscoveryService, 'discover' | 'rediscover'>;
  lifecycle: LocalLifecycleController;
  logger: DesktopLogger;
  desktopSession: Session;
  devServerUrl: string | undefined;
  packagedRendererUrl: string;
  openExternal(url: string): Promise<void>;
  onRendererActiveProfileChanged?(origin: string | null): void;
  /** @internal Deterministic admitted-work accounting for lifecycle proof. */
  observeInvocation?(phase: 'entry' | 'exit', channel: string): void;
  /** @internal Fixed, secret-free packaged Connect acceptance evidence. */
  reportAcceptanceJourneyStage?(stage: DesktopAcceptanceJourneyStage): void;
  /** @internal Fixed, secret-free packaged Connect operation evidence. */
  reportAcceptanceOperation?(
    operation: DesktopAcceptanceOperation,
    status: DesktopAcceptanceOperationStatus,
  ): void;
}

type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;

export interface RegisteredIpcHandlers {
  close(): void;
  awaitIdle(): Promise<void>;
  dispose(): void;
}

const closingError = (): Error => new Error('DESKTOP_CLOSING');
const acceptanceStages = new Set<DesktopAcceptanceJourneyStage>([
  'AUTHENTICATION_REQUIRED',
  'CREDENTIAL_COMMITTED',
  'AUTHENTICATED_REPROBE_READY',
  'ACTIVATION_COMMITTED',
  'ACTIVATION_PUBLISHED',
  'REACT_CONNECTED',
]);
const acceptanceOperations = new Map<string, DesktopAcceptanceOperation>([
  [IPC_CHANNELS.profilesSave, 'PROFILE_SAVE'],
  [IPC_CHANNELS.authenticationPair, 'PAIR'],
  [IPC_CHANNELS.connectionProbe, 'PROBE'],
  [IPC_CHANNELS.connectionActivate, 'ACTIVATE'],
]);

const acceptanceStatus = (result: unknown): DesktopAcceptanceOperationStatus => {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !('status' in result)) {
    return 'COMPLETED';
  }
  const status = (result as { status?: unknown }).status;
  if (status === 'ready') return 'READY';
  if (status === 'authentication-required') return 'AUTHENTICATION_REQUIRED';
  if (status === 'incompatible') return 'INCOMPATIBLE';
  if (status === 'offline') return 'OFFLINE';
  return 'COMPLETED';
};

export const registerIpcHandlers = (options: RegisterIpcOptions): RegisteredIpcHandlers => {
  const channels = new Set<string>();
  const active = new Set<Promise<unknown>>();
  let closing = false;
  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const senderUrl = event.senderFrame?.url ?? '';
    return isTrustedRendererUrl(senderUrl, options.devServerUrl, options.packagedRendererUrl);
  };
  const handle = (channel: string, handler: Handler): void => {
    channels.add(channel);
    options.ipcMain.handle(channel, async (event, ...args) => {
      if (closing) throw closingError();
      if (!trusted(event)) {
        options.logger.log('warn', 'desktop.ipc.rejected', { channel });
        throw new Error('Untrusted desktop IPC sender');
      }
      options.observeInvocation?.('entry', channel);
      const invocation = Promise.resolve().then(() => handler(event, ...args));
      active.add(invocation);
      try {
        const result = await invocation;
        const operation = acceptanceOperations.get(channel);
        if (operation) options.reportAcceptanceOperation?.(operation, acceptanceStatus(result));
        return result;
      } catch (error) {
        const operation = acceptanceOperations.get(channel);
        if (operation) options.reportAcceptanceOperation?.(operation, 'REJECTED');
        options.logger.log('error', 'desktop.ipc.failed', { channel, code: 'IPC_OPERATION_FAILED' });
        throw new Error('Desktop operation failed [IPC_OPERATION_FAILED]');
      } finally {
        active.delete(invocation);
        options.observeInvocation?.('exit', channel);
      }
    });
  };
  const reconcileRendererActiveProfile = async (): Promise<void> => {
    if (!options.onRendererActiveProfileChanged) return;
    const current = await options.credentials.listProfiles();
    const activeOrigin = current.profiles
      .find(profile => profile.id === current.activeProfileId)?.apiBaseUrl ?? null;
    options.onRendererActiveProfileChanged(activeOrigin);
  };

  handle(IPC_CHANNELS.appMetadata, () => ({
    name: options.app.getName(),
    version: options.app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: options.app.isPackaged,
  }));
  handle(IPC_CHANNELS.authLogout, (_event, apiBaseUrl) => logoutDesktopSession(options.desktopSession, apiBaseUrl));
  handle(IPC_CHANNELS.openExternal, async (_event, value: unknown) => {
    if (typeof value !== 'string' || !isSafeExternalUrl(value)) throw new Error('External URL is not allowed');
    await options.openExternal(value);
  });
  handle(IPC_CHANNELS.storageSecurity, () => options.credentials.storageSecurity());
  handle(IPC_CHANNELS.profilesList, () => options.credentials.listProfiles());
  handle(IPC_CHANNELS.profilesSave, async (_event, input) => {
    const profile = await options.credentials.saveProfile(
      input,
      (previousOrigin, nextOrigin) => clearDesktopInstanceCookies(
        options.desktopSession,
        [previousOrigin, nextOrigin],
      ),
    );
    await reconcileRendererActiveProfile();
    return profile;
  });
  handle(IPC_CHANNELS.profilesRemove, async (_event, profileId) => {
    await options.credentials.removeProfile(
      profileId,
      origin => clearDesktopInstanceCookies(options.desktopSession, [origin]),
    );
    await reconcileRendererActiveProfile();
  });
  handle(IPC_CHANNELS.profilesSetActive, async (_event, profileId) => {
    const current = await options.credentials.listProfiles();
    const previous = current.profiles.find(profile => profile.id === current.activeProfileId);
    const next = current.profiles.find(profile => profile.id === profileId);
    if (profileId !== null && !next) throw new Error('Desktop profile does not exist');
    await clearDesktopInstanceCookies(options.desktopSession, [
      ...(previous ? [previous.apiBaseUrl] : []),
      ...(next ? [next.apiBaseUrl] : []),
    ]);
    await options.credentials.setActiveProfile(profileId);
    await reconcileRendererActiveProfile();
  });
  handle(IPC_CHANNELS.authenticationPair, (_event, profile) => options.credentials.pair(profile));
  handle(IPC_CHANNELS.authenticationCancel, (_event, profileId) => options.credentials.cancelPairing(profileId));
  handle(IPC_CHANNELS.connectionProbe, (_event, profile) => options.credentials.probe(profile));
  handle(IPC_CHANNELS.connectionActivate, async (_event, activationTicket) => {
    const before = await options.credentials.listProfiles();
    const activated = await options.credentials.activate(activationTicket);
    try {
      const after = await options.credentials.listProfiles();
      const previousOrigin = before.profiles
        .find(profile => profile.id === before.activeProfileId)?.apiBaseUrl;
      const activatedOrigin = after.profiles
        .find(profile => profile.id === after.activeProfileId)?.apiBaseUrl;
      const origins = [previousOrigin, activatedOrigin].filter(origin => origin !== undefined);
      await clearDesktopInstanceCookies(options.desktopSession, origins);
      if (!activatedOrigin) throw new Error('Desktop activation did not establish a renderer origin');
      await reconcileRendererActiveProfile();
      return activated;
    } catch (error) {
      const discarded = await options.credentials.discardActivation({
        profileId: activated.profileId,
        transportScope: activated.transportScope,
      });
      if (discarded.discarded) await reconcileRendererActiveProfile();
      throw error;
    }
  });
  handle(IPC_CHANNELS.connectionDiscard, async (_event, value) => {
    const discarded = await options.credentials.discardActivation(value);
    if (discarded.discarded) await reconcileRendererActiveProfile();
    return discarded;
  });
  handle(IPC_CHANNELS.connectionInvalidate, (_event, value) => options.credentials.invalidate(value));
  handle(IPC_CHANNELS.connectDiscover, (_event, ...args) => {
    if (args.length) throw new Error('Invalid Connect discovery request');
    return options.connectDiscovery.discover();
  });
  handle(IPC_CHANNELS.connectRediscover, (_event, profileId, ...args) => {
    if (args.length) throw new Error('Invalid Connect rediscovery request');
    return options.connectDiscovery.rediscover(profileId);
  });
  if (options.reportAcceptanceJourneyStage) {
    handle(IPC_CHANNELS.acceptanceJourneyStage, (_event, stage, ...args) => {
      if (args.length || !acceptanceStages.has(stage)) throw new Error('Invalid acceptance journey stage');
      options.reportAcceptanceJourneyStage!(stage);
    });
  }
  handle(IPC_CHANNELS.lifecycleStatus, () => options.lifecycle.status());
  handle(IPC_CHANNELS.lifecycleStart, () => options.lifecycle.start());
  handle(IPC_CHANNELS.lifecycleStop, () => options.lifecycle.stop());
  handle(IPC_CHANNELS.lifecycleRestart, () => options.lifecycle.restart());
  return {
    close() {
      if (closing) return;
      closing = true;
      for (const channel of channels) {
        options.ipcMain.removeHandler(channel);
        options.ipcMain.handle(channel, () => Promise.reject(closingError()));
      }
    },
    async awaitIdle() {
      while (active.size > 0) await Promise.allSettled([...active]);
    },
    dispose() {
      closing = true;
      for (const channel of channels) options.ipcMain.removeHandler(channel);
    },
  };
};

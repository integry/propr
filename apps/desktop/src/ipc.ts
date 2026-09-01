import type { App, IpcMain, IpcMainInvokeEvent, Session } from 'electron';
import { clearDesktopInstanceCookies, logoutDesktopSession } from './desktop-session';
import type { DesktopCredentialService } from './credential-service';
import type { DesktopLogger } from './logger';
import type { DesktopOperationCoordinator } from './operation-coordinator';
import type { LocalLifecycleController } from './lifecycle';
import type { ProfileStore } from './profile-store';
import type { DesktopSetupController } from './setup-controller';
import { isSafeExternalUrl, isTrustedRendererUrl } from './security';
import { IPC_CHANNELS } from './shared/contract';

interface RegisterIpcOptions {
  app: App;
  ipcMain: IpcMain;
  profiles: ProfileStore;
  credentials: DesktopCredentialService;
  lifecycle: LocalLifecycleController;
  setup?: DesktopSetupController;
  logger: DesktopLogger;
  desktopSession: Session;
  devServerUrl: string | undefined;
  packagedRendererUrl: string;
  coordinator?: DesktopOperationCoordinator;
  openExternal(url: string): Promise<void>;
  /** @internal Deterministic admitted-work accounting for lifecycle proof. */
  observeInvocation?(phase: 'entry' | 'exit', channel: string): void;
}

type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;

export interface RegisteredIpcHandlers {
  close(): void;
  awaitIdle(): Promise<void>;
  dispose(): void;
}

const closingError = (): Error => new Error('DESKTOP_CLOSING');

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
        return await invocation;
      } catch (error) {
        options.logger.log('error', 'desktop.ipc.failed', { channel, error });
        throw new Error('Desktop operation failed. Review the protected desktop log for details.');
      } finally {
        active.delete(invocation);
        options.observeInvocation?.('exit', channel);
      }
    });
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
  handle(IPC_CHANNELS.profilesSave, (_event, input) => options.credentials.saveProfile(
    input,
    (previousOrigin, nextOrigin) => clearDesktopInstanceCookies(
      options.desktopSession,
      [previousOrigin, nextOrigin],
    ),
  ));
  handle(IPC_CHANNELS.profilesRemove, (_event, profileId) => options.credentials.removeProfile(
    profileId,
    origin => clearDesktopInstanceCookies(options.desktopSession, [origin]),
  ));
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
  });
  handle(IPC_CHANNELS.authenticationPair, (_event, profile) => options.credentials.pair(profile));
  handle(IPC_CHANNELS.authenticationCancel, (_event, profileId) => options.credentials.cancelPairing(profileId));
  handle(IPC_CHANNELS.connectionPrepareLocal, (_event, profile) => options.credentials.prepareLocalActivation(profile));
  handle(IPC_CHANNELS.connectionActivateLocal, (_event, localActivationTicket) => options.credentials.activateLocal(
    localActivationTicket,
    (previousOrigin, nextOrigin) => clearDesktopInstanceCookies(
      options.desktopSession,
      [previousOrigin, nextOrigin].filter((origin): origin is string => origin !== undefined),
    ),
  ));
  handle(IPC_CHANNELS.connectionDiscardLocal, (_event, localActivationTicket) =>
    options.credentials.discardLocal(localActivationTicket));
  handle(IPC_CHANNELS.connectionProbe, (_event, profile) => options.credentials.probe(profile));
  handle(IPC_CHANNELS.connectionActivate, async (_event, activationTicket) => {
    const before = await options.credentials.listProfiles();
    const activated = await options.credentials.activate(activationTicket);
    try {
      const after = await options.credentials.listProfiles();
      const previousOrigin = before.profiles.find(profile => profile.id === before.activeProfileId)?.apiBaseUrl;
      const activatedOrigin = after.profiles.find(profile => profile.id === after.activeProfileId)?.apiBaseUrl;
      await clearDesktopInstanceCookies(
        options.desktopSession,
        [previousOrigin, activatedOrigin].filter((origin): origin is string => origin !== undefined),
      );
      return activated;
    } catch (error) {
      await options.credentials.discardActivation({
        profileId: activated.profileId,
        transportScope: activated.transportScope,
      });
      throw error;
    }
  });
  handle(IPC_CHANNELS.connectionDiscard, (_event, value) => options.credentials.discardActivation(value));
  handle(IPC_CHANNELS.connectionInvalidate, (_event, value) => options.credentials.invalidate(value));
  handle(IPC_CHANNELS.lifecycleStatus, () => options.coordinator
    ? options.coordinator.run('status', signal => options.lifecycle.status(signal))
    : options.lifecycle.status());
  handle(IPC_CHANNELS.lifecycleStart, () => options.coordinator
    ? options.coordinator.run('start', signal => options.lifecycle.start(signal))
    : options.lifecycle.start());
  handle(IPC_CHANNELS.lifecycleStop, () => options.coordinator
    ? options.coordinator.run('stop', signal => options.lifecycle.stop(signal))
    : options.lifecycle.stop());
  handle(IPC_CHANNELS.lifecycleRestart, () => options.coordinator
    ? options.coordinator.run('restart', signal => options.lifecycle.restart(signal))
    : options.lifecycle.restart());
  handle(IPC_CHANNELS.discovery, () => []);
  if (options.setup && options.coordinator) {
    const setup = options.setup;
    const coordinator = options.coordinator;
    handle(IPC_CHANNELS.setupStatus, (_event, ...args) => {
      if (args.length) throw new Error('Invalid local setup status request');
      return setup.status();
    });
    handle(IPC_CHANNELS.setupStart, (_event, ...args) => {
      if (args.length !== 1) throw new Error('Invalid local setup start request');
      return coordinator.run('setup', signal => setup.start(args[0], signal));
    });
    handle(IPC_CHANNELS.setupRetry, (_event, ...args) => {
      if (args.length > 1) throw new Error('Invalid local setup retry request');
      return coordinator.run('setup', signal => setup.retry(args[0], signal));
    });
    handle(IPC_CHANNELS.setupCancel, (_event, ...args) => {
      if (args.length) throw new Error('Invalid local setup cancellation request');
      return coordinator.cancel(() => setup.cancel());
    });
    handle(IPC_CHANNELS.setupSelectPrivateKey, (_event, ...args) => {
      if (args.length) throw new Error('Invalid private-key selection request');
      return coordinator.run('setup', signal => setup.selectPrivateKey(signal));
    });
    handle(IPC_CHANNELS.setupAcquireWebhookSecret, (_event, ...args) => {
      if (args.length) throw new Error('Invalid webhook-secret acquisition request');
      return coordinator.run('setup', signal => setup.acquireWebhookSecret(signal));
    });
  }
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

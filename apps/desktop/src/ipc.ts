import type { App, IpcMain, IpcMainInvokeEvent, Session } from 'electron';
import { shell } from 'electron';
import { clearDesktopInstanceCookies, logoutDesktopSession } from './desktop-session';
import type { DesktopCredentialService } from './credential-service';
import type { DesktopLogger } from './logger';
import type { LocalLifecycleController } from './lifecycle';
import type { ProfileStore } from './profile-store';
import { isSafeExternalUrl, isTrustedRendererUrl } from './security';
import { IPC_CHANNELS } from './shared/contract';

interface RegisterIpcOptions {
  app: App;
  ipcMain: IpcMain;
  profiles: ProfileStore;
  credentials: DesktopCredentialService;
  lifecycle: LocalLifecycleController;
  logger: DesktopLogger;
  desktopSession: Session;
  devServerUrl: string | undefined;
  packagedRendererUrl: string;
}

type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;

export const registerIpcHandlers = (options: RegisterIpcOptions): void => {
  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const senderUrl = event.senderFrame?.url ?? '';
    return isTrustedRendererUrl(senderUrl, options.devServerUrl, options.packagedRendererUrl);
  };
  const handle = (channel: string, handler: Handler): void => {
    options.ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) {
        options.logger.log('warn', 'desktop.ipc.rejected', { channel });
        throw new Error('Untrusted desktop IPC sender');
      }
      try {
        return await handler(event, ...args);
      } catch (error) {
        options.logger.log('error', 'desktop.ipc.failed', { channel, error });
        throw error;
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
    await shell.openExternal(value);
  });
  handle(IPC_CHANNELS.storageSecurity, () => options.profiles.security());
  handle(IPC_CHANNELS.profilesList, () => options.profiles.list());
  handle(IPC_CHANNELS.profilesSave, (_event, input) => options.credentials.saveProfile(input));
  handle(IPC_CHANNELS.profilesRemove, async (_event, profileId) => {
    const removedOrigin = await options.credentials.removeProfile(profileId);
    if (removedOrigin) await clearDesktopInstanceCookies(options.desktopSession, [removedOrigin]);
  });
  handle(IPC_CHANNELS.profilesSetActive, async (_event, profileId) => {
    const current = await options.profiles.list();
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
  handle(IPC_CHANNELS.connectionProbe, (_event, profile) => options.credentials.probe(profile));
  handle(IPC_CHANNELS.connectionActivate, async (_event, activationTicket) => {
    const before = await options.profiles.list();
    const activated = await options.credentials.activate(activationTicket);
    const after = await options.profiles.list();
    const origins = [before.activeProfileId, after.activeProfileId]
      .flatMap(profileId => after.profiles.find(profile => profile.id === profileId)?.apiBaseUrl
        ?? before.profiles.find(profile => profile.id === profileId)?.apiBaseUrl
        ?? []);
    await clearDesktopInstanceCookies(options.desktopSession, origins).catch(() => undefined);
    return activated;
  });
  handle(IPC_CHANNELS.connectionDiscard, (_event, value) => options.credentials.discardActivation(value));
  handle(IPC_CHANNELS.connectionInvalidate, (_event, value) => options.credentials.invalidate(value));
  handle(IPC_CHANNELS.lifecycleStatus, () => options.lifecycle.status());
  handle(IPC_CHANNELS.lifecycleStart, () => options.lifecycle.start());
  handle(IPC_CHANNELS.lifecycleStop, () => options.lifecycle.stop());
  handle(IPC_CHANNELS.lifecycleRestart, () => options.lifecycle.restart());
};

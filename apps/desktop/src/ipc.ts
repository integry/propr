import type { App, IpcMain, IpcMainInvokeEvent, Session } from 'electron';
import { shell } from 'electron';
import { logoutDesktopSession } from './desktop-session';
import type { DesktopLogger } from './logger';
import type { LocalLifecycleController } from './lifecycle';
import type { ProfileStore } from './profile-store';
import type { DesktopSetupController } from './setup-controller';
import { isSafeExternalUrl, isTrustedRendererUrl } from './security';
import { IPC_CHANNELS } from './shared/contract';

interface RegisterIpcOptions {
  app: App;
  ipcMain: IpcMain;
  profiles: ProfileStore;
  lifecycle: LocalLifecycleController;
  setup: DesktopSetupController;
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
  handle(IPC_CHANNELS.profilesSave, (_event, input) => options.profiles.save(input));
  handle(IPC_CHANNELS.profilesRemove, (_event, profileId) => options.profiles.remove(profileId));
  handle(IPC_CHANNELS.profilesSetActive, (_event, profileId) => options.profiles.setActive(profileId));
  handle(IPC_CHANNELS.lifecycleStatus, () => options.lifecycle.status());
  handle(IPC_CHANNELS.lifecycleStart, () => options.lifecycle.start());
  handle(IPC_CHANNELS.lifecycleStop, () => options.lifecycle.stop());
  handle(IPC_CHANNELS.lifecycleRestart, () => options.lifecycle.restart());
  handle(IPC_CHANNELS.discovery, () => []);
  handle(IPC_CHANNELS.setupStatus, (_event, ...args) => {
    if (args.length) throw new Error('Invalid local setup status request');
    return options.setup.status();
  });
  handle(IPC_CHANNELS.setupStart, (_event, ...args) => {
    if (args.length !== 1) throw new Error('Invalid local setup start request');
    return options.setup.start(args[0]);
  });
  handle(IPC_CHANNELS.setupRetry, (_event, ...args) => {
    if (args.length > 1) throw new Error('Invalid local setup retry request');
    return options.setup.retry(args[0]);
  });
  handle(IPC_CHANNELS.setupCancel, (_event, ...args) => {
    if (args.length) throw new Error('Invalid local setup cancellation request');
    return options.setup.cancel();
  });
  handle(IPC_CHANNELS.setupSelectDirectory, (_event, ...args) => {
    if (args.length) throw new Error('Invalid directory selection request');
    return options.setup.selectDirectory();
  });
  handle(IPC_CHANNELS.setupSelectPrivateKey, (_event, ...args) => {
    if (args.length) throw new Error('Invalid private-key selection request');
    return options.setup.selectPrivateKey();
  });
};

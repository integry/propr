import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { App, IpcMain, IpcMainInvokeEvent, Session } from 'electron';
import type { DesktopCredentialService } from './credential-service';
import { registerIpcHandlers } from './ipc';
import type { LocalLifecycleController } from './lifecycle';
import type { DesktopLogger } from './logger';
import { createDesktopBridge, type PreloadIpc } from './preload-bridge';
import type { ProfileStore } from './profile-store';

const rendererUrl = 'propr-app://renderer/renderer.html';

describe('main-to-preload Connect discovery IPC', () => {
  it('returns only typed candidates and redacts underlying discovery failures', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    let fail = false;
    const registered = registerIpcHandlers({
      app: { getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true } as unknown as App,
      ipcMain: {
        handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
        removeHandler: (channel: string) => { handlers.delete(channel); },
      } as unknown as IpcMain,
      profiles: {} as ProfileStore,
      credentials: {} as DesktopCredentialService,
      connectDiscovery: {
        discover: async () => {
          if (fail) throw new Error('token-sentinel at /private/native/root');
          return [{
            id: 'connect-candidate',
            label: 'ProPR Connect',
            apiBaseUrl: 'https://t-discovered123.propr.dev',
          }];
        },
        rediscover: async profileId => ({
          id: String(profileId),
          label: 'Saved connection',
          apiBaseUrl: 'https://t-recovered456.propr.dev',
        }),
      },
      lifecycle: {} as LocalLifecycleController,
      logger: { log: () => undefined } as unknown as DesktopLogger,
      desktopSession: {} as Session,
      devServerUrl: undefined,
      packagedRendererUrl: rendererUrl,
      openExternal: async () => undefined,
    });
    const event = { senderFrame: { url: rendererUrl } } as unknown as IpcMainInvokeEvent;
    const ipc: PreloadIpc = {
      invoke: (channel, ...args) => Promise.resolve(handlers.get(channel)!(event, ...args)),
      on: () => undefined,
      removeListener: () => undefined,
    };
    const bridge = createDesktopBridge(ipc, true);

    assert.deepEqual(await bridge.discovery.discover(), [{
      id: 'connect-candidate',
      label: 'ProPR Connect',
      apiBaseUrl: 'https://t-discovered123.propr.dev',
    }]);
    assert.deepEqual(await bridge.discovery.rediscover('saved-profile'), {
      id: 'saved-profile',
      label: 'Saved connection',
      apiBaseUrl: 'https://t-recovered456.propr.dev',
    });
    fail = true;
    await assert.rejects(
      bridge.discovery.discover(),
      (error: unknown) => String(error) === 'Error: Desktop operation failed [IPC_OPERATION_FAILED]',
    );
    registered.dispose();
  });
});

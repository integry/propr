import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { App, IpcMain, IpcMainInvokeEvent, Session } from 'electron';
import type { DesktopCredentialService } from './credential-service';
import { registerIpcHandlers } from './ipc';
import type { LocalLifecycleController } from './lifecycle';
import type { DesktopLogger } from './logger';
import type { ProfileStore } from './profile-store';
import { IPC_CHANNELS } from './shared/contract';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
};

describe('desktop IPC shutdown gate', () => {
  it('replaces every handler with a fixed closing failure and drains admitted work before disposal', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const ipcMain = {
      handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
      removeHandler: (channel: string) => { handlers.delete(channel); },
    } as unknown as IpcMain;
    const listResult = deferred<{ profiles: []; activeProfileId: null }>();
    let listCalls = 0;
    const credentials = {
      listProfiles: async () => {
        listCalls += 1;
        return listResult.promise;
      },
    } as unknown as DesktopCredentialService;
    const registered = registerIpcHandlers({
      app: {
        getName: () => 'ProPR',
        getVersion: () => '0.8.15',
        isPackaged: true,
      } as unknown as App,
      ipcMain,
      profiles: {} as ProfileStore,
      credentials,
      lifecycle: {} as LocalLifecycleController,
      logger: { log: () => undefined } as unknown as DesktopLogger,
      desktopSession: {} as Session,
      devServerUrl: undefined,
      packagedRendererUrl: 'propr-renderer://app/index.html',
      openExternal: async () => undefined,
    });
    const event = {
      senderFrame: { url: 'propr-renderer://app/index.html' },
    } as unknown as IpcMainInvokeEvent;
    const invoke = (channel: string) => Promise.resolve(handlers.get(channel)!(event));

    const admitted = invoke(IPC_CHANNELS.profilesList);
    await Promise.resolve();
    registered.close();
    await assert.rejects(invoke(IPC_CHANNELS.profilesList), /DESKTOP_CLOSING/);
    assert.equal(listCalls, 1);

    let idle = false;
    const draining = registered.awaitIdle().then(() => { idle = true; });
    await Promise.resolve();
    assert.equal(idle, false);
    listResult.resolve({ profiles: [], activeProfileId: null });
    await admitted;
    await draining;

    registered.dispose();
    assert.equal(handlers.size, 0);
  });
});

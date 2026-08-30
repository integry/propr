import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { App, IpcMain, IpcMainInvokeEvent, Session } from 'electron';
import type { DesktopCredentialService } from './credential-service';
import { registerIpcHandlers } from './ipc';
import type { LocalLifecycleController } from './lifecycle';
import type { DesktopLogger } from './logger';
import type { ProfileStore } from './profile-store';
import { IPC_CHANNELS } from './shared/contract';
import { createDesktopShutdownCoordinator } from './shutdown';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
};

describe('desktop IPC shutdown gate', () => {
  it('clears both origins when activation edits the active profile URL without changing its ID', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const ipcMain = {
      handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
      removeHandler: (channel: string) => { handlers.delete(channel); },
    } as unknown as IpcMain;
    const before = {
      id: 'profile-a', label: 'A', apiBaseUrl: 'https://old.example.test',
      createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
    };
    const after = {
      ...before,
      apiBaseUrl: 'https://new.example.test',
      updatedAt: '2026-08-30T00:01:00.000Z',
    };
    let listCalls = 0;
    const credentials = {
      listProfiles: async () => ({
        profiles: [listCalls++ === 0 ? before : after],
        activeProfileId: 'profile-a',
      }),
      activate: async () => ({
        status: 'ready', profileId: 'profile-a', transportScope: 'scope-b', identityEpoch: 'B'.repeat(22),
      }),
    } as unknown as DesktopCredentialService;
    const cleared: Array<Parameters<Session['clearStorageData']>[0]> = [];
    const desktopSession = {
      clearStorageData: async (options: Parameters<Session['clearStorageData']>[0]) => {
        cleared.push(options);
      },
    } as unknown as Session;
    registerIpcHandlers({
      app: {
        getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true,
      } as unknown as App,
      ipcMain,
      profiles: {} as ProfileStore,
      credentials,
      lifecycle: {} as LocalLifecycleController,
      logger: { log: () => undefined } as unknown as DesktopLogger,
      desktopSession,
      devServerUrl: undefined,
      packagedRendererUrl: 'propr-renderer://app/index.html',
      openExternal: async () => undefined,
    });
    const event = {
      senderFrame: { url: 'propr-renderer://app/index.html' },
    } as unknown as IpcMainInvokeEvent;

    const activated = await Promise.resolve(
      handlers.get(IPC_CHANNELS.connectionActivate)!(event, 'T'.repeat(43)),
    );

    assert.deepEqual(activated, {
      status: 'ready', profileId: 'profile-a', transportScope: 'scope-b', identityEpoch: 'B'.repeat(22),
    });
    assert.equal(listCalls, 2);
    assert.deepEqual(cleared, [
      {
        origin: 'https://old.example.test',
        storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers'],
      },
      {
        origin: 'https://new.example.test',
        storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers'],
      },
    ]);
  });

  it('rejects activation and discards its exact scope when origin storage clearing fails', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const ipcMain = {
      handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
      removeHandler: (channel: string) => { handlers.delete(channel); },
    } as unknown as IpcMain;
    const profiles = [
      {
        id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test',
        createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
      },
      {
        id: 'profile-b', label: 'B', apiBaseUrl: 'https://b.example.test',
        createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
      },
    ];
    let listCalls = 0;
    const discarded: Array<{ profileId: string; transportScope: string }> = [];
    const credentials = {
      listProfiles: async () => ({
        profiles,
        activeProfileId: listCalls++ === 0 ? 'profile-a' : 'profile-b',
      }),
      activate: async () => ({
        status: 'ready', profileId: 'profile-b', transportScope: 'scope-b', identityEpoch: 'B'.repeat(22),
      }),
      discardActivation: async (scope: { profileId: string; transportScope: string }) => {
        discarded.push(scope);
        return { discarded: true };
      },
    } as unknown as DesktopCredentialService;
    let clearCalls = 0;
    const desktopSession = {
      clearStorageData: async () => {
        clearCalls += 1;
        if (clearCalls === 2) throw new Error('storage clear failed');
      },
    } as unknown as Session;
    registerIpcHandlers({
      app: {
        getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true,
      } as unknown as App,
      ipcMain,
      profiles: {} as ProfileStore,
      credentials,
      lifecycle: {} as LocalLifecycleController,
      logger: { log: () => undefined } as unknown as DesktopLogger,
      desktopSession,
      devServerUrl: undefined,
      packagedRendererUrl: 'propr-renderer://app/index.html',
      openExternal: async () => undefined,
    });
    const event = {
      senderFrame: { url: 'propr-renderer://app/index.html' },
    } as unknown as IpcMainInvokeEvent;

    await assert.rejects(
      Promise.resolve(handlers.get(IPC_CHANNELS.connectionActivate)!(event, 'T'.repeat(43))),
      /storage clear failed/,
    );
    assert.equal(clearCalls, 2);
    assert.deepEqual(discarded, [{ profileId: 'profile-b', transportScope: 'scope-b' }]);
  });

  it('discards the exact activation when the post-commit profile read fails', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const ipcMain = {
      handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
      removeHandler: (channel: string) => { handlers.delete(channel); },
    } as unknown as IpcMain;
    let listCalls = 0;
    let discardCalls = 0;
    const discardActivation = async (scope: { profileId: string; transportScope: string }) => {
      discardCalls += 1;
      assert.deepEqual(scope, { profileId: 'profile-b', transportScope: 'scope-b' });
      return { discarded: true };
    };
    const credentials = {
      listProfiles: async () => {
        listCalls += 1;
        if (listCalls === 2) throw new Error('post-activation profile read failed');
        return { profiles: [], activeProfileId: null };
      },
      activate: async () => ({
        status: 'ready', profileId: 'profile-b', transportScope: 'scope-b', identityEpoch: 'B'.repeat(22),
      }),
      discardActivation,
    } as unknown as DesktopCredentialService;
    const desktopSession = {
      clearStorageData: async () => { throw new Error('storage clearing should not start'); },
    } as unknown as Session;
    registerIpcHandlers({
      app: { getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true } as unknown as App,
      ipcMain,
      profiles: {} as ProfileStore,
      credentials,
      lifecycle: {} as LocalLifecycleController,
      logger: { log: () => undefined } as unknown as DesktopLogger,
      desktopSession,
      devServerUrl: undefined,
      packagedRendererUrl: 'propr-renderer://app/index.html',
      openExternal: async () => undefined,
    });
    const event = { senderFrame: { url: 'propr-renderer://app/index.html' } } as unknown as IpcMainInvokeEvent;

    await assert.rejects(
      Promise.resolve(handlers.get(IPC_CHANNELS.connectionActivate)!(event, 'T'.repeat(43))),
      /post-activation profile read failed/,
    );
    assert.equal(listCalls, 2);
    assert.equal(discardCalls, 1);
  });

  it('clears a profile origin before committing removal and retains it when cleanup fails', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const ipcMain = {
      handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
      removeHandler: (channel: string) => { handlers.delete(channel); },
    } as unknown as IpcMain;
    let removalCommitted = false;
    const credentials = {
      removeProfile: async (
        _profileId: string,
        beforeCommit: (origin: string) => Promise<void>,
      ) => {
        await beforeCommit('https://a.example.test');
        removalCommitted = true;
        return 'https://a.example.test';
      },
    } as unknown as DesktopCredentialService;
    const desktopSession = {
      clearStorageData: async () => { throw new Error('origin storage clear failed'); },
    } as unknown as Session;
    registerIpcHandlers({
      app: { getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true } as unknown as App,
      ipcMain,
      profiles: {} as ProfileStore,
      credentials,
      lifecycle: {} as LocalLifecycleController,
      logger: { log: () => undefined } as unknown as DesktopLogger,
      desktopSession,
      devServerUrl: undefined,
      packagedRendererUrl: 'propr-renderer://app/index.html',
      openExternal: async () => undefined,
    });
    const event = { senderFrame: { url: 'propr-renderer://app/index.html' } } as unknown as IpcMainInvokeEvent;

    await assert.rejects(
      Promise.resolve(handlers.get(IPC_CHANNELS.profilesRemove)!(event, 'profile-a')),
      /origin storage clear failed/,
    );
    assert.equal(removalCommitted, false);
  });

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

  for (const category of ['profile', 'pairing', 'session'] as const) {
    it(`runs an admitted ${category} handler through the production before-quit drain`, async () => {
      const handlers = new Map<string, (...args: any[]) => unknown>();
      const ipcMain = {
        handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
        removeHandler: (channel: string) => { handlers.delete(channel); },
      } as unknown as IpcMain;
      const barrier = deferred<unknown>();
      const started = deferred<void>();
      let underlyingCalls = 0;
      const begin = (): Promise<unknown> => {
        underlyingCalls += 1;
        started.resolve(undefined);
        return barrier.promise;
      };
      const credentials = {
        listProfiles: category === 'profile' ? begin : async () => ({ profiles: [], activeProfileId: null }),
        pair: category === 'pairing' ? begin : async () => ({ paired: true }),
        dispose: async () => undefined,
      } as unknown as DesktopCredentialService;
      const desktopSession = {
        fetch: category === 'session'
          ? async () => await begin() as Response
          : async () => new Response(null, { status: 204 }),
      } as unknown as Session;
      const registered = registerIpcHandlers({
        app: {
          getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true,
        } as unknown as App,
        ipcMain,
        profiles: {} as ProfileStore,
        credentials,
        lifecycle: {} as LocalLifecycleController,
        logger: { log: () => undefined } as unknown as DesktopLogger,
        desktopSession,
        devServerUrl: undefined,
        packagedRendererUrl: 'propr-renderer://app/index.html',
        openExternal: async () => undefined,
      });
      const event = {
        senderFrame: { url: 'propr-renderer://app/index.html' },
      } as unknown as IpcMainInvokeEvent;
      const invoke = (channel: string, ...args: unknown[]) =>
        Promise.resolve(handlers.get(channel)!(event, ...args));
      const channel = category === 'profile'
        ? IPC_CHANNELS.profilesList
        : category === 'pairing'
          ? IPC_CHANNELS.authenticationPair
          : IPC_CHANNELS.authLogout;
      const args = category === 'pairing'
        ? [{ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' }]
        : category === 'session' ? ['https://a.example.test'] : [];
      const admitted = invoke(channel, ...args);
      await started.promise;

      const order: string[] = [];
      const shutdown = createDesktopShutdownCoordinator({
        credentials: { dispose: async () => { order.push('credentials-dispose'); } },
        lifecycle: { shutdown: async () => { order.push('lifecycle-shutdown'); } },
        ipc: {
          close: () => { order.push('ipc-close'); registered.close(); },
          awaitIdle: () => { order.push('ipc-drain'); return registered.awaitIdle(); },
          dispose: () => { order.push('ipc-dispose'); registered.dispose(); },
        },
        profiles: { close: async () => { order.push('profiles-close'); } },
        sessionSecurity: {
          close: () => { order.push('session-close'); },
          dispose: () => { order.push('session-dispose'); },
        },
        disposeRendererProtocol: () => { order.push('protocol-dispose'); },
        getWindow: () => ({
          isDestroyed: () => false,
          destroy: () => { order.push('window-destroy'); },
        }),
        quit: () => { order.push('app-quit'); },
        onStarted: () => { order.push('shutdown-started'); },
        log: () => undefined,
      });
      shutdown.beforeQuit({ preventDefault: () => undefined });
      await assert.rejects(invoke(channel, ...args), /DESKTOP_CLOSING/);
      assert.equal(underlyingCalls, 1);

      if (category === 'profile') barrier.resolve({ profiles: [], activeProfileId: null });
      else if (category === 'pairing') barrier.resolve({ paired: true });
      else barrier.resolve(new Response(null, { status: 204 }));
      await admitted;
      await shutdown.awaitFinished();

      assert.equal(handlers.size, 0);
      assert.equal(order.indexOf('profiles-close') > order.indexOf('ipc-drain'), true);
      assert.equal(order.indexOf('session-dispose') > order.indexOf('profiles-close'), true);
      assert.deepEqual(order.slice(-3), ['ipc-dispose', 'window-destroy', 'app-quit']);
    });
  }
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { App, IpcMain, IpcMainInvokeEvent, Session } from 'electron';
import type { DesktopCredentialService } from './credential-service';
import { registerIpcHandlers } from './ipc';
import type { LocalLifecycleController } from './lifecycle';
import type { DesktopLogger } from './logger';
import type { ProfileStore } from './profile-store';
import { rendererContentSecurityPolicy } from './security';
import { IPC_CHANNELS } from './shared/contract';
import { createDesktopShutdownCoordinator } from './shutdown';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
};

const connectDiscovery = {
  discover: async () => [],
  rediscover: async () => null,
};

describe('desktop IPC shutdown gate', () => {
  it('clears old and new origin storage through the real save IPC before a same-ID URL commit', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const cleared: Array<Parameters<Session['clearStorageData']>[0]> = [];
    let cleanupObservedBeforeSave = false;
    let reconciledOrigin: string | null | undefined;
    const credentials = {
      saveProfile: async (
        input: { id: string; label: string; apiBaseUrl: string },
        beforeCommit: (previousOrigin: string, nextOrigin: string) => Promise<void>,
      ) => {
        await beforeCommit('https://old.example.test', input.apiBaseUrl);
        cleanupObservedBeforeSave = cleared.length === 2;
        return input;
      },
      listProfiles: async () => ({
        profiles: [{
          id: 'profile-a', label: 'A edited', apiBaseUrl: 'http://localhost:4100',
          createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:01:00.000Z',
        }],
        activeProfileId: 'profile-a',
      }),
    } as unknown as DesktopCredentialService;
    registerIpcHandlers({
      app: { getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true } as unknown as App,
      ipcMain: {
        handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
        removeHandler: (channel: string) => { handlers.delete(channel); },
      } as unknown as IpcMain,
      profiles: {} as ProfileStore,
      credentials,
      connectDiscovery,
      lifecycle: {} as LocalLifecycleController,
      logger: { log: () => undefined } as unknown as DesktopLogger,
      desktopSession: {
        clearStorageData: async (options: Parameters<Session['clearStorageData']>[0]) => { cleared.push(options); },
      } as unknown as Session,
      devServerUrl: undefined,
      packagedRendererUrl: 'propr-renderer://app/index.html',
      openExternal: async () => undefined,
      onRendererActiveProfileChanged: origin => { reconciledOrigin = origin; },
    });
    const event = {
      senderFrame: { url: 'propr-renderer://app/index.html' },
    } as unknown as IpcMainInvokeEvent;

    await Promise.resolve(handlers.get(IPC_CHANNELS.profilesSave)!(event, {
      id: 'profile-a', label: 'A edited', apiBaseUrl: 'http://localhost:4100',
    }));

    assert.equal(cleanupObservedBeforeSave, true);
    assert.equal(reconciledOrigin, 'http://localhost:4100');
    assert.deepEqual(cleared, [
      {
        origin: 'https://old.example.test',
        storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers'],
      },
      {
        origin: 'http://localhost:4100',
        storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers'],
      },
    ]);
  });

  it('reconciles the renderer policy after setting a different active profile', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const profiles = [
      {
        id: 'profile-a', label: 'A', apiBaseUrl: 'http://localhost:4000',
        createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
      },
      {
        id: 'profile-b', label: 'B', apiBaseUrl: 'http://127.0.0.1:4100',
        createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
      },
    ];
    let activeProfileId: string | null = 'profile-a';
    const credentials = {
      listProfiles: async () => ({ profiles, activeProfileId }),
      setActiveProfile: async (profileId: string | null) => { activeProfileId = profileId; },
    } as unknown as DesktopCredentialService;
    let reconciledOrigin: string | null | undefined;
    registerIpcHandlers({
      app: { getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true } as unknown as App,
      ipcMain: {
        handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
        removeHandler: (channel: string) => { handlers.delete(channel); },
      } as unknown as IpcMain,
      profiles: {} as ProfileStore,
      credentials,
      connectDiscovery,
      lifecycle: {} as LocalLifecycleController,
      logger: { log: () => undefined } as unknown as DesktopLogger,
      desktopSession: { clearStorageData: async () => undefined } as unknown as Session,
      devServerUrl: undefined,
      packagedRendererUrl: 'propr-renderer://app/index.html',
      openExternal: async () => undefined,
      onRendererActiveProfileChanged: origin => { reconciledOrigin = origin; },
    });
    const event = {
      senderFrame: { url: 'propr-renderer://app/index.html' },
    } as unknown as IpcMainInvokeEvent;

    await Promise.resolve(handlers.get(IPC_CHANNELS.profilesSetActive)!(event, 'profile-b'));

    assert.equal(reconciledOrigin, profiles[1].apiBaseUrl);
  });

  it('clears the renderer policy after removing the active profile', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    let removed = false;
    const credentials = {
      removeProfile: async (
        _profileId: string,
        beforeCommit: (origin: string) => Promise<void>,
      ) => {
        await beforeCommit('http://localhost:4000');
        removed = true;
        return 'http://localhost:4000';
      },
      listProfiles: async () => ({ profiles: [], activeProfileId: null }),
    } as unknown as DesktopCredentialService;
    let reconciledOrigin: string | null | undefined;
    registerIpcHandlers({
      app: { getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true } as unknown as App,
      ipcMain: {
        handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
        removeHandler: (channel: string) => { handlers.delete(channel); },
      } as unknown as IpcMain,
      profiles: {} as ProfileStore,
      credentials,
      connectDiscovery,
      lifecycle: {} as LocalLifecycleController,
      logger: { log: () => undefined } as unknown as DesktopLogger,
      desktopSession: { clearStorageData: async () => undefined } as unknown as Session,
      devServerUrl: undefined,
      packagedRendererUrl: 'propr-renderer://app/index.html',
      openExternal: async () => undefined,
      onRendererActiveProfileChanged: origin => { reconciledOrigin = origin; },
    });
    const event = {
      senderFrame: { url: 'propr-renderer://app/index.html' },
    } as unknown as IpcMainInvokeEvent;

    await Promise.resolve(handlers.get(IPC_CHANNELS.profilesRemove)!(event, 'profile-a'));

    assert.equal(removed, true);
    assert.equal(reconciledOrigin, null);
  });

  it('removes cleartext renderer sources after discarding the active loopback connection', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const profile = {
      id: 'profile-a', label: 'A', apiBaseUrl: 'http://localhost:4000',
      createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
    };
    let activeProfileId: string | null = profile.id;
    let policy = rendererContentSecurityPolicy(false, [profile.apiBaseUrl]);
    let listCalls = 0;
    const credentials = {
      discardActivation: async () => {
        activeProfileId = null;
        return { discarded: true };
      },
      listProfiles: async () => {
        listCalls += 1;
        return { profiles: [profile], activeProfileId };
      },
    } as unknown as DesktopCredentialService;
    registerIpcHandlers({
      app: { getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true } as unknown as App,
      ipcMain: {
        handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
        removeHandler: (channel: string) => { handlers.delete(channel); },
      } as unknown as IpcMain,
      profiles: {} as ProfileStore,
      credentials,
      connectDiscovery,
      lifecycle: {} as LocalLifecycleController,
      logger: { log: () => undefined } as unknown as DesktopLogger,
      desktopSession: {} as Session,
      devServerUrl: undefined,
      packagedRendererUrl: 'propr-renderer://app/index.html',
      openExternal: async () => undefined,
      onRendererActiveProfileChanged: origin => {
        policy = rendererContentSecurityPolicy(false, origin ? [origin] : []);
      },
    });
    const event = { senderFrame: { url: 'propr-renderer://app/index.html' } } as unknown as IpcMainInvokeEvent;

    const result = await Promise.resolve(handlers.get(IPC_CHANNELS.connectionDiscard)!(event, {
      profileId: profile.id,
      transportScope: 'scope-a',
    }));

    assert.deepEqual(result, { discarded: true });
    assert.equal(listCalls, 1);
    assert.equal(policy.includes(profile.apiBaseUrl), false);
    assert.equal(policy.includes('ws://localhost:4000'), false);
  });

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
    let reconciledOrigin: string | null | undefined;
    registerIpcHandlers({
      app: {
        getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true,
      } as unknown as App,
      ipcMain,
      profiles: {} as ProfileStore,
      credentials,
      connectDiscovery,
      lifecycle: {} as LocalLifecycleController,
      logger: { log: () => undefined } as unknown as DesktopLogger,
      desktopSession,
      devServerUrl: undefined,
      packagedRendererUrl: 'propr-renderer://app/index.html',
      openExternal: async () => undefined,
      onRendererActiveProfileChanged: origin => { reconciledOrigin = origin; },
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
    assert.equal(listCalls, 3);
    assert.equal(reconciledOrigin, after.apiBaseUrl);
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

  it('publishes the current active profile when another mutation completes during activation cleanup', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const profiles = [
      {
        id: 'profile-a', label: 'A', apiBaseUrl: 'http://localhost:4000',
        createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
      },
      {
        id: 'profile-b', label: 'B', apiBaseUrl: 'http://127.0.0.1:4100',
        createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
      },
      {
        id: 'profile-c', label: 'C', apiBaseUrl: 'http://[::1]:4200',
        createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
      },
    ];
    let activeProfileId: string | null = profiles[0].id;
    const credentials = {
      listProfiles: async () => ({ profiles, activeProfileId }),
      activate: async () => {
        activeProfileId = profiles[1].id;
        return {
          status: 'ready', profileId: profiles[1].id,
          transportScope: 'scope-b', identityEpoch: 'B'.repeat(22),
        };
      },
      setActiveProfile: async (profileId: string | null) => { activeProfileId = profileId; },
    } as unknown as DesktopCredentialService;
    const activationCleanupStarted = deferred<void>();
    const finishActivationCleanup = deferred<void>();
    let profileBClearCalls = 0;
    const desktopSession = {
      clearStorageData: async (options: Parameters<Session['clearStorageData']>[0]) => {
        if (options?.origin !== profiles[1].apiBaseUrl || ++profileBClearCalls !== 1) return;
        activationCleanupStarted.resolve(undefined);
        await finishActivationCleanup.promise;
      },
    } as unknown as Session;
    const reconciledOrigins: Array<string | null> = [];
    registerIpcHandlers({
      app: { getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true } as unknown as App,
      ipcMain: {
        handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
        removeHandler: (channel: string) => { handlers.delete(channel); },
      } as unknown as IpcMain,
      profiles: {} as ProfileStore,
      credentials,
      connectDiscovery,
      lifecycle: {} as LocalLifecycleController,
      logger: { log: () => undefined } as unknown as DesktopLogger,
      desktopSession,
      devServerUrl: undefined,
      packagedRendererUrl: 'propr-renderer://app/index.html',
      openExternal: async () => undefined,
      onRendererActiveProfileChanged: origin => { reconciledOrigins.push(origin); },
    });
    const event = { senderFrame: { url: 'propr-renderer://app/index.html' } } as unknown as IpcMainInvokeEvent;

    const activation = Promise.resolve(
      handlers.get(IPC_CHANNELS.connectionActivate)!(event, 'T'.repeat(43)),
    );
    await activationCleanupStarted.promise;
    await Promise.resolve(handlers.get(IPC_CHANNELS.profilesSetActive)!(event, profiles[2].id));
    finishActivationCleanup.resolve(undefined);
    await activation;

    assert.deepEqual(reconciledOrigins, [profiles[2].apiBaseUrl, profiles[2].apiBaseUrl]);
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
    let activeProfileId: string | null = 'profile-a';
    const discarded: Array<{ profileId: string; transportScope: string }> = [];
    const credentials = {
      listProfiles: async () => {
        listCalls += 1;
        return { profiles, activeProfileId };
      },
      activate: async () => {
        activeProfileId = 'profile-b';
        return {
          status: 'ready', profileId: 'profile-b', transportScope: 'scope-b', identityEpoch: 'B'.repeat(22),
        };
      },
      discardActivation: async (scope: { profileId: string; transportScope: string }) => {
        discarded.push(scope);
        activeProfileId = null;
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
    let reconciledOrigin: string | null | undefined;
    registerIpcHandlers({
      app: {
        getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true,
      } as unknown as App,
      ipcMain,
      profiles: {} as ProfileStore,
      credentials,
      connectDiscovery,
      lifecycle: {} as LocalLifecycleController,
      logger: { log: () => undefined } as unknown as DesktopLogger,
      desktopSession,
      devServerUrl: undefined,
      packagedRendererUrl: 'propr-renderer://app/index.html',
      openExternal: async () => undefined,
      onRendererActiveProfileChanged: origin => { reconciledOrigin = origin; },
    });
    const event = {
      senderFrame: { url: 'propr-renderer://app/index.html' },
    } as unknown as IpcMainInvokeEvent;

    await assert.rejects(
      Promise.resolve(handlers.get(IPC_CHANNELS.connectionActivate)!(event, 'T'.repeat(43))),
      /Desktop operation failed \[IPC_OPERATION_FAILED\]/,
    );
    assert.equal(clearCalls, 2);
    assert.equal(listCalls, 3);
    assert.deepEqual(discarded, [{ profileId: 'profile-b', transportScope: 'scope-b' }]);
    assert.equal(reconciledOrigin, null);
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
      connectDiscovery,
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
      /Desktop operation failed \[IPC_OPERATION_FAILED\]/,
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
      connectDiscovery,
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
      /Desktop operation failed \[IPC_OPERATION_FAILED\]/,
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
      connectDiscovery,
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
        connectDiscovery,
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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDesktopBridge, type PreloadIpc } from './preload-bridge';
import { IPC_CHANNELS } from './shared/contract';

const pairingOperationId = '123e4567-e89b-42d3-a456-426614174000';

class FakeIpc implements PreloadIpc {
  readonly invocations: Array<{ channel: string; args: unknown[] }> = [];
  readonly listeners = new Map<string, (event: unknown, value: unknown) => void>();

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invocations.push({ channel, args });
    if (channel === IPC_CHANNELS.authenticationPairAdmit) return { operationId: pairingOperationId };
    if (channel === IPC_CHANNELS.deepLinkConsumerReady) return { pendingConnect: false };
    return undefined;
  }

  on(channel: string, listener: (event: unknown, value: unknown) => void): void {
    this.listeners.set(channel, listener);
  }

  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): void {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }
}

describe('desktop preload bridge', () => {
  it('exposes only the narrow frozen namespaces', () => {
    const bridge = createDesktopBridge(new FakeIpc());
    assert.deepEqual(Object.keys(bridge).sort(), ['app', 'auth', 'authentication', 'connection', 'discovery', 'external', 'lifecycle', 'localSetup', 'notifications', 'profiles', 'storage', ...((process.platform === 'linux' || process.platform === 'darwin') ? ['voice'] : [])]);
    assert.equal(Object.isFrozen(bridge), true);
    assert.equal(Object.values(bridge).every(Object.isFrozen), true);
    assert.equal('fs' in bridge, false);
    assert.equal('exec' in bridge, false);
  });

  it('requires a live user gesture before microphone consent IPC', { skip: process.platform !== 'linux' && process.platform !== 'darwin' }, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const ipc = new FakeIpc();
    const voice = createDesktopBridge(ipc).voice!;
    try {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userActivation: { isActive: false } } });
      assert.equal(await voice.requestMicrophone(), false);
      assert.equal(ipc.invocations.length, 0);
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userActivation: { isActive: true } } });
      await voice.requestMicrophone();
      await voice.revokeMicrophone();
      assert.deepEqual(ipc.invocations, [
        { channel: IPC_CHANNELS.microphoneRequest, args: [] },
        { channel: IPC_CHANNELS.microphoneRevoke, args: [] },
      ]);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('maps notifications to fixed channels and accepts only internal task navigation', async () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    const native = bridge.notifications;
    assert.ok(native);
    const scope = { profileId: 'profile-1', transportScope: 'abcdefghijklmnopqrstuv', userId: '42' };
    const event = {
      taskId: 'task-1', state: 'failed', previousState: 'processing',
      timestamp: '2026-09-07T18:45:00.000Z', version: 2,
    };
    await native.get(scope);
    await native.update(scope, { enabled: true });
    await native.test(scope);
    await native.publish(scope, event);
    await native.clear(scope);
    const paths: string[] = [];
    const changedScopes: unknown[] = [];
    const unsubscribeChanges = native.onSettingsChanged(value => changedScopes.push(value));
    ipc.listeners.get(IPC_CHANNELS.notificationsChanged)?.({}, scope);
    ipc.listeners.get(IPC_CHANNELS.notificationsChanged)?.({}, { ...scope, unexpected: true });
    ipc.listeners.get(IPC_CHANNELS.notificationsChanged)?.({}, { ...scope, transportScope: 'short' });
    unsubscribeChanges();
    ipc.listeners.get(IPC_CHANNELS.notificationsChanged)?.({}, scope);
    const unsubscribe = native.onNavigate(path => paths.push(path));
    ipc.listeners.get(IPC_CHANNELS.notificationNavigate)?.({}, '/tasks/task-1');
    ipc.listeners.get(IPC_CHANNELS.notificationNavigate)?.({}, 'https://attacker.example');
    ipc.listeners.get(IPC_CHANNELS.notificationNavigate)?.({}, '/settings');
    unsubscribe();
    assert.deepEqual(changedScopes, [scope]);
    assert.deepEqual(paths, ['/tasks/task-1']);
    assert.deepEqual(ipc.invocations, [
      { channel: IPC_CHANNELS.notificationsGet, args: [scope] },
      { channel: IPC_CHANNELS.notificationsUpdate, args: [scope, { enabled: true }] },
      { channel: IPC_CHANNELS.notificationsTest, args: [scope] },
      { channel: IPC_CHANNELS.notificationsPublish, args: [scope, event] },
      { channel: IPC_CHANNELS.notificationsClear, args: [scope] },
    ]);
  });

  it('buffers only fixed native commands and never exposes arbitrary renderer navigation', () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    const connectionScope = { profileId: 'profile-1', transportScope: 'abcdefghijklmnopqrstuv' };
    ipc.listeners.get(IPC_CHANNELS.nativeCommand)?.({}, { command: 'tasks', connectionScope });
    ipc.listeners.get(IPC_CHANNELS.nativeCommand)?.({}, { command: 'https://attacker.example', connectionScope });
    ipc.listeners.get(IPC_CHANNELS.nativeCommand)?.({}, { command: 'tasks' });
    ipc.listeners.get(IPC_CHANNELS.nativeCommand)?.({}, { command: 'plans', connectionScope });
    const commands: unknown[] = [];
    const unsubscribe = bridge.app.onNativeCommand(delivery => commands.push(delivery));
    ipc.listeners.get(IPC_CHANNELS.nativeCommand)?.({}, { command: 'notification-settings', connectionScope });
    ipc.listeners.get(IPC_CHANNELS.nativeCommand)?.({}, { command: 'quit', connectionScope: null });
    unsubscribe();
    ipc.listeners.get(IPC_CHANNELS.nativeCommand)?.({}, { command: 'inbox', connectionScope });
    assert.deepEqual(commands, [
      { command: 'plans', connectionScope },
      { command: 'notification-settings', connectionScope },
      { command: 'quit', connectionScope: null },
    ]);
  });

  it('maps profile and main-process authentication operations to fixed channels', async () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    await bridge.app.quit();
    await bridge.app.refreshActiveWork();
    await bridge.app.minimize();
    await bridge.app.toggleMaximize();
    await bridge.app.closeWindow();
    await bridge.auth.logout({ profileId: 'profile-1', transportScope: 'transport-scope' });
    await bridge.profiles.save({ label: 'Local', apiBaseUrl: 'http://localhost:4000' });
    const admission = await bridge.authentication.admit('profile-1');
    await bridge.authentication.pair(
      { id: 'profile-1', label: 'Local', apiBaseUrl: 'http://localhost:4000' },
      admission.operationId,
    );
    await bridge.authentication.reopenApproval('profile-1', admission.operationId);
    await bridge.authentication.copyApproval('profile-1', admission.operationId);
    await bridge.connection.activate('activation-ticket');
    await bridge.connection.discard({ profileId: 'profile-1', transportScope: 'transport-scope' });
    await bridge.discovery.discover();
    await bridge.discovery.rediscover('profile-1');
    await bridge.lifecycle.start();
    assert.deepEqual(ipc.invocations, [
      { channel: IPC_CHANNELS.appQuit, args: [] },
      { channel: IPC_CHANNELS.activeWorkRefresh, args: [] },
      { channel: IPC_CHANNELS.windowMinimize, args: [] },
      { channel: IPC_CHANNELS.windowToggleMaximize, args: [] },
      { channel: IPC_CHANNELS.windowClose, args: [] },
      { channel: IPC_CHANNELS.authLogout, args: [{ profileId: 'profile-1', transportScope: 'transport-scope' }] },
      {
        channel: IPC_CHANNELS.profilesSave,
        args: [{ label: 'Local', apiBaseUrl: 'http://localhost:4000' }],
      },
      {
        channel: IPC_CHANNELS.authenticationPairAdmit,
        args: ['profile-1'],
      },
      {
        channel: IPC_CHANNELS.authenticationPair,
        args: [
          { id: 'profile-1', label: 'Local', apiBaseUrl: 'http://localhost:4000' },
          pairingOperationId,
        ],
      },
      {
        channel: IPC_CHANNELS.authenticationReopenApproval,
        args: ['profile-1', pairingOperationId],
      },
      {
        channel: IPC_CHANNELS.authenticationCopyApproval,
        args: ['profile-1', pairingOperationId],
      },
      { channel: IPC_CHANNELS.connectionActivate, args: ['activation-ticket'] },
      {
        channel: IPC_CHANNELS.connectionDiscard,
        args: [{ profileId: 'profile-1', transportScope: 'transport-scope' }],
      },
      { channel: IPC_CHANNELS.connectDiscover, args: [] },
      { channel: IPC_CHANNELS.connectRediscover, args: ['profile-1'] },
      { channel: IPC_CHANNELS.lifecycleStart, args: [] },
    ]);
    assert.equal(bridge.discovery.supported, true);
  });

  it('forwards only fixed secret-free pairing progress values', () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    const received: unknown[] = [];
    const unsubscribe = bridge.authentication.onProgress?.(value => received.push(value));

    ipc.listeners.get(IPC_CHANNELS.authenticationProgress)?.({}, {
      operationId: pairingOperationId, profileId: 'profile-1', stage: 'approval-pending',
      approvalUrl: 'https://must-not-leak.invalid',
    });
    ipc.listeners.get(IPC_CHANNELS.authenticationProgress)?.({}, {
      operationId: pairingOperationId, profileId: 'profile-1', stage: 'unknown',
    });
    ipc.listeners.get(IPC_CHANNELS.authenticationProgress)?.({}, {
      operationId: pairingOperationId, profileId: 'profile-1', stage: 'browser-open-failed',
    });
    unsubscribe?.();

    assert.deepEqual(received, [{
      operationId: pairingOperationId, profileId: 'profile-1', stage: 'browser-open-failed',
    }]);
  });

  it('can advertise an unsupported host without exposing a renderer-selected root', () => {
    const bridge = createDesktopBridge(new FakeIpc(), false);
    assert.equal(bridge.discovery.supported, false);
    assert.deepEqual(Object.keys(bridge.discovery).sort(), ['discover', 'rediscover', 'supported']);
  });

  it('maps setup operations to fixed channels and forwards snapshot values without Electron events', async () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    const snapshots: unknown[] = [];
    const unsubscribe = bridge.localSetup.onProgress(value => snapshots.push(value));
    const request = { sessionId: '11111111-1111-4111-8111-111111111111', root: { mode: 'default' as const },
      reinitialize: false, agents: [], github: { mode: 'keep' as const }, intake: { mode: 'keep' as const }, whitelist: null, repository: null };
    await bridge.localSetup.status();
    await bridge.localSetup.start(request);
    await bridge.localSetup.retry();
    await bridge.localSetup.resolveGithubInstallation({ action: 'refresh' });
    await bridge.localSetup.cancel();
    ipc.listeners.get(IPC_CHANNELS.setupProgress)?.({ mustNotLeak: true }, { phase: 'running' } as never);
    unsubscribe();
    assert.deepEqual(ipc.invocations.map(value => value.channel), [
      IPC_CHANNELS.setupStatus, IPC_CHANNELS.setupStart, IPC_CHANNELS.setupRetry,
      IPC_CHANNELS.setupGithubInstallationDecision, IPC_CHANNELS.setupCancel,
    ]);
    assert.deepEqual(snapshots, [{ phase: 'running' }]);
  });

  it('exposes only a fixed stage reporter when packaged Connect acceptance is authorized', async () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc, true, true);
    assert.deepEqual(Object.keys(bridge.acceptance ?? {}), ['reportJourneyStage']);
    await bridge.acceptance?.reportJourneyStage('CREDENTIAL_COMMITTED');
    assert.deepEqual(ipc.invocations, [{
      channel: IPC_CHANNELS.acceptanceJourneyStage,
      args: ['CREDENTIAL_COMMITTED'],
    }]);
  });

  it('does not expose Electron event objects to deep-link listeners', () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    const received: string[] = [];
    const unsubscribe = bridge.app.onDeepLink(value => {
      received.push(value);
      return { kind: 'open-queued', target: '/tasks' };
    });
    ipc.listeners.get(IPC_CHANNELS.deepLink)?.({ sender: 'must-not-leak' }, {
      deliveryId: 1,
      url: 'propr://open?path=%2Ftasks',
    });
    assert.deepEqual(received, ['propr://open?path=%2Ftasks']);
    unsubscribe();
    assert.equal(ipc.listeners.has(IPC_CHANNELS.deepLink), true);
  });

  it('reports readiness once for each interval with an installed deep-link consumer', async () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    const first = bridge.app.onDeepLink(() => null);
    const second = bridge.app.onDeepLink(() => null);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ipc.invocations, [
      { channel: IPC_CHANNELS.deepLinkConsumerReady, args: [] },
    ]);

    first();
    second();
    bridge.app.onDeepLink(() => null);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ipc.invocations, [
      { channel: IPC_CHANNELS.deepLinkConsumerReady, args: [] },
      { channel: IPC_CHANNELS.deepLinkConsumerReady, args: [] },
    ]);
  });

  for (const pendingConnect of [false, true]) {
    it(`waits for consumer registration before reporting startup Connect intent (${pendingConnect})`, async () => {
      const ipc = new FakeIpc();
      let reply!: (value: unknown) => void;
      ipc.invoke = async () => new Promise(resolve => { reply = resolve; });
      const bridge = createDesktopBridge(ipc);
      let settled = false;
      const intent = bridge.app.hasStartupConnectIntent!().then(value => {
        settled = true;
        return value;
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false);
      bridge.app.onDeepLink(() => null);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false);
      reply({ pendingConnect });
      assert.equal(await intent, pendingConnect);
    });
  }

  it('rejects failed consumer readiness instead of permitting automatic reconnect', async () => {
    const ipc = new FakeIpc();
    ipc.invoke = async () => { throw new Error('Readiness rejected'); };
    const bridge = createDesktopBridge(ipc);
    const intent = bridge.app.hasStartupConnectIntent!();
    bridge.app.onDeepLink(() => null);
    await assert.rejects(intent, /Readiness rejected/);
  });

  it('buffers startup and second-instance deep links until the renderer subscribes', async () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    const receiveDeepLink = ipc.listeners.get(IPC_CHANNELS.deepLink);
    assert.ok(receiveDeepLink, 'preload must register its IPC listener eagerly');

    receiveDeepLink({}, { deliveryId: 1, url: 'propr://connect?api=http%3A%2F%2Flocalhost%3A4000' });
    receiveDeepLink({}, { deliveryId: 2, url: 'propr://open?path=%2Ftasks' });

    const received: string[] = [];
    bridge.app.onDeepLink(value => {
      received.push(value);
      return value.includes('connect')
        ? { kind: 'connect-confirmation', target: 'http://localhost:4000' }
        : { kind: 'open-queued', target: '/tasks' };
    });
    assert.deepEqual(received, [
      'propr://connect?api=http%3A%2F%2Flocalhost%3A4000',
      'propr://open?path=%2Ftasks',
    ]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ipc.invocations, [
      { channel: IPC_CHANNELS.deepLinkConsumerReady, args: [] },
      {
        channel: IPC_CHANNELS.deepLinkAcknowledgement,
        args: [{
          deliveryId: 1,
          url: 'propr://connect?api=http%3A%2F%2Flocalhost%3A4000',
          consumption: { kind: 'connect-confirmation', target: 'http://localhost:4000' },
        }],
      },
      {
        channel: IPC_CHANNELS.deepLinkAcknowledgement,
        args: [{
          deliveryId: 2,
          url: 'propr://open?path=%2Ftasks',
          consumption: { kind: 'open-queued', target: '/tasks' },
        }],
      },
    ]);
  });
});

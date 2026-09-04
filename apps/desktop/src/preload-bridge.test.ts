import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDesktopBridge, type PreloadIpc } from './preload-bridge';
import { IPC_CHANNELS } from './shared/contract';

class FakeIpc implements PreloadIpc {
  readonly invocations: Array<{ channel: string; args: unknown[] }> = [];
  readonly listeners = new Map<string, (event: unknown, value: unknown) => void>();

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invocations.push({ channel, args });
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
    assert.deepEqual(Object.keys(bridge).sort(), ['app', 'auth', 'authentication', 'connection', 'discovery', 'external', 'lifecycle', 'profiles', 'storage']);
    assert.equal(Object.isFrozen(bridge), true);
    assert.equal(Object.values(bridge).every(Object.isFrozen), true);
    assert.equal('fs' in bridge, false);
    assert.equal('exec' in bridge, false);
  });

  it('maps profile and main-process authentication operations to fixed channels', async () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    await bridge.auth.logout('http://localhost:4000');
    await bridge.profiles.save({ label: 'Local', apiBaseUrl: 'http://localhost:4000' });
    await bridge.authentication.pair({ id: 'profile-1', label: 'Local', apiBaseUrl: 'http://localhost:4000' });
    await bridge.connection.activate('activation-ticket');
    await bridge.connection.discard({ profileId: 'profile-1', transportScope: 'transport-scope' });
    await bridge.discovery.discover();
    await bridge.discovery.rediscover('profile-1');
    await bridge.lifecycle.start();
    assert.deepEqual(ipc.invocations, [
      { channel: IPC_CHANNELS.authLogout, args: ['http://localhost:4000'] },
      {
        channel: IPC_CHANNELS.profilesSave,
        args: [{ label: 'Local', apiBaseUrl: 'http://localhost:4000' }],
      },
      {
        channel: IPC_CHANNELS.authenticationPair,
        args: [{ id: 'profile-1', label: 'Local', apiBaseUrl: 'http://localhost:4000' }],
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

  it('can advertise an unsupported host without exposing a renderer-selected root', () => {
    const bridge = createDesktopBridge(new FakeIpc(), false);
    assert.equal(bridge.discovery.supported, false);
    assert.deepEqual(Object.keys(bridge.discovery).sort(), ['discover', 'rediscover', 'supported']);
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

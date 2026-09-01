import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDesktopBridge, type PreloadIpc } from './preload-bridge';
import { IPC_CHANNELS } from './shared/contract';

class FakeIpc implements PreloadIpc {
  readonly invocations: Array<{ channel: string; args: unknown[] }> = [];
  readonly listeners = new Map<string, (event: unknown, value: string) => void>();

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invocations.push({ channel, args });
    return undefined;
  }

  on(channel: string, listener: (event: unknown, value: string) => void): void {
    this.listeners.set(channel, listener);
  }

  removeListener(channel: string, listener: (event: unknown, value: string) => void): void {
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

  it('does not expose Electron event objects to deep-link listeners', () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    const received: string[] = [];
    const unsubscribe = bridge.app.onDeepLink(value => received.push(value));
    ipc.listeners.get(IPC_CHANNELS.deepLink)?.({ sender: 'must-not-leak' }, 'propr://open?path=%2Ftasks');
    assert.deepEqual(received, ['propr://open?path=%2Ftasks']);
    unsubscribe();
    assert.equal(ipc.listeners.has(IPC_CHANNELS.deepLink), true);
  });

  it('buffers startup and second-instance deep links until the renderer subscribes', () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    const receiveDeepLink = ipc.listeners.get(IPC_CHANNELS.deepLink);
    assert.ok(receiveDeepLink, 'preload must register its IPC listener eagerly');

    receiveDeepLink({}, 'propr://connect?api=http%3A%2F%2Flocalhost%3A4000');
    receiveDeepLink({}, 'propr://open?path=%2Ftasks');

    const received: string[] = [];
    bridge.app.onDeepLink(value => received.push(value));
    assert.deepEqual(received, [
      'propr://connect?api=http%3A%2F%2Flocalhost%3A4000',
      'propr://open?path=%2Ftasks',
    ]);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDesktopBridge, createDesktopRendererBridge, type PreloadIpc } from './preload-bridge';
import { IPC_CHANNELS } from './shared/contract';

class FakeIpc implements PreloadIpc {
  readonly invocations: Array<{ channel: string; args: unknown[] }> = [];
  readonly listeners = new Map<string, (event: unknown, value: any) => void>();

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invocations.push({ channel, args });
    return undefined;
  }

  on(channel: string, listener: (event: unknown, value: any) => void): void {
    this.listeners.set(channel, listener);
  }

  removeListener(channel: string, listener: (event: unknown, value: any) => void): void {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }
}

describe('desktop preload bridge', () => {
  it('exposes only the narrow frozen namespaces', () => {
    const bridge = createDesktopBridge(new FakeIpc());
    assert.deepEqual(Object.keys(bridge).sort(), ['app', 'auth', 'credentials', 'external', 'lifecycle', 'profiles', 'storage']);
    assert.equal(Object.isFrozen(bridge), true);
    assert.equal(Object.values(bridge).every(Object.isFrozen), true);
    assert.equal('fs' in bridge, false);
    assert.equal('exec' in bridge, false);
  });

  it('maps profile and credential operations to fixed channels', async () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    await bridge.auth.logout('http://localhost:4000');
    await bridge.profiles.save({ label: 'Local', apiBaseUrl: 'http://localhost:4000' });
    await bridge.credentials.write('profile-1', 'secret');
    await bridge.lifecycle.start();
    assert.deepEqual(ipc.invocations, [
      { channel: IPC_CHANNELS.authLogout, args: ['http://localhost:4000'] },
      {
        channel: IPC_CHANNELS.profilesSave,
        args: [{ label: 'Local', apiBaseUrl: 'http://localhost:4000' }],
      },
      { channel: IPC_CHANNELS.credentialsWrite, args: ['profile-1', 'secret'] },
      { channel: IPC_CHANNELS.lifecycleStart, args: [] },
    ]);
  });

  it('exposes setup through fixed invocations and strips Electron events from progress', async () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopRendererBridge(ipc, 'linux');
    const received: unknown[] = [];
    bridge.localSetup.onProgress(snapshot => received.push(snapshot));
    const request = {
      rootDir: '/srv/propr', reinitialize: false, agents: [], loginAgents: [],
      github: { mode: 'demo' as const }, intake: { mode: 'keep' as const }, whitelist: null, repository: null,
    };
    await bridge.localSetup.start(request);
    ipc.listeners.get(IPC_CHANNELS.setupProgress)?.(
      { sender: 'must-not-leak' },
      { phase: 'running', capability: { supported: true, kind: 'local', platform: 'linux' }, logs: [] },
    );

    assert.deepEqual(ipc.invocations, [{ channel: IPC_CHANNELS.setupStart, args: [request] }]);
    assert.deepEqual(received, [{ phase: 'running', capability: { supported: true, kind: 'local', platform: 'linux' }, logs: [] }]);
    assert.equal('invoke' in bridge, false);
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

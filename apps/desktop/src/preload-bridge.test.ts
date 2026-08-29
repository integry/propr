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
    assert.deepEqual(Object.keys(bridge).sort(), ['app', 'credentials', 'external', 'lifecycle', 'profiles', 'storage']);
    assert.equal(Object.isFrozen(bridge), true);
    assert.equal(Object.values(bridge).every(Object.isFrozen), true);
    assert.equal('fs' in bridge, false);
    assert.equal('exec' in bridge, false);
  });

  it('maps profile and credential operations to fixed channels', async () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    await bridge.profiles.save({ label: 'Local', apiBaseUrl: 'http://localhost:4000' });
    await bridge.credentials.write('profile-1', 'secret');
    await bridge.lifecycle.start();
    assert.deepEqual(ipc.invocations, [
      {
        channel: IPC_CHANNELS.profilesSave,
        args: [{ label: 'Local', apiBaseUrl: 'http://localhost:4000' }],
      },
      { channel: IPC_CHANNELS.credentialsWrite, args: ['profile-1', 'secret'] },
      { channel: IPC_CHANNELS.lifecycleStart, args: [] },
    ]);
  });

  it('does not expose Electron event objects to deep-link listeners', () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    const received: string[] = [];
    const unsubscribe = bridge.app.onDeepLink(value => received.push(value));
    ipc.listeners.get(IPC_CHANNELS.deepLink)?.({ sender: 'must-not-leak' }, 'propr://open?path=%2Ftasks');
    assert.deepEqual(received, ['propr://open?path=%2Ftasks']);
    unsubscribe();
    assert.equal(ipc.listeners.has(IPC_CHANNELS.deepLink), false);
  });
});

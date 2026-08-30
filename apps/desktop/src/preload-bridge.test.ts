import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDesktopBridge, createDesktopRendererBridge, probeLocalDesktopProfile, type PreloadIpc } from './preload-bridge';
import { IPC_CHANNELS } from './shared/contract';
import { PROPR_API_COMPATIBILITY } from '@propr/shared';

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
    assert.deepEqual(Object.keys(bridge).sort(), ['app', 'auth', 'external', 'lifecycle', 'profiles', 'storage']);
    assert.equal(Object.isFrozen(bridge), true);
    assert.equal(Object.values(bridge).every(Object.isFrozen), true);
    assert.equal('fs' in bridge, false);
    assert.equal('exec' in bridge, false);
  });

  it('maps profile operations to fixed channels without a credential namespace', async () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopBridge(ipc);
    await bridge.auth.logout('http://localhost:4000');
    await bridge.profiles.save({ label: 'Local', apiBaseUrl: 'http://localhost:4000' });
    await bridge.lifecycle.start();
    assert.deepEqual(ipc.invocations, [
      { channel: IPC_CHANNELS.authLogout, args: ['http://localhost:4000'] },
      {
        channel: IPC_CHANNELS.profilesSave,
        args: [{ label: 'Local', apiBaseUrl: 'http://localhost:4000' }],
      },
      { channel: IPC_CHANNELS.lifecycleStart, args: [] },
    ]);
  });

  it('exposes setup through fixed invocations and strips Electron events from progress', async () => {
    const ipc = new FakeIpc();
    const bridge = createDesktopRendererBridge(ipc, 'linux');
    const received: unknown[] = [];
    bridge.localSetup.onProgress(snapshot => received.push(snapshot));
    const request = {
      sessionId: '00000000-0000-4000-8000-000000000000', root: { mode: 'default' as const }, reinitialize: false, agents: [],
      github: { mode: 'demo' as const }, intake: { mode: 'keep' as const }, whitelist: null, repository: null,
    };
    await bridge.localSetup.start(request);
    ipc.listeners.get(IPC_CHANNELS.setupProgress)?.(
      { sender: 'must-not-leak' },
      { phase: 'running', capability: { supported: true, kind: 'local', platform: 'linux' }, sessionId: request.sessionId, logs: [] },
    );

    assert.deepEqual(ipc.invocations, [{ channel: IPC_CHANNELS.setupStart, args: [request] }]);
    assert.deepEqual(received, [{ phase: 'running', capability: { supported: true, kind: 'local', platform: 'linux' }, sessionId: request.sessionId, logs: [] }]);
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

  it('probes completed local profiles through the injectable connection boundary', async () => {
    const profile = { id: 'local', name: 'This computer', baseUrl: 'http://127.0.0.1:4000', kind: 'local' as const };
    const requests: string[] = [];
    const result = await probeLocalDesktopProfile(profile, async input => {
      requests.push(input.toString());
      return new Response(JSON.stringify({ apiCompatibility: PROPR_API_COMPATIBILITY, version: '0.8.15' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    assert.deepEqual(requests, ['http://127.0.0.1:4000/api/compatibility']);
    assert.equal(result.status, 'ready');

    const injected = async () => ({ status: 'ready' as const, version: 'injected' });
    const bridge = createDesktopRendererBridge(new FakeIpc(), 'linux', injected);
    assert.deepEqual(await bridge.connection.probe(profile), { status: 'ready', version: 'injected' });
  });

  it('keeps remote probing out of the local setup lane and bounds local failures', async () => {
    const remote = await probeLocalDesktopProfile({ id: 'remote', name: 'Remote', baseUrl: 'https://example.com', kind: 'remote' }, async () => {
      throw new Error('must not fetch');
    });
    assert.deepEqual(remote, { status: 'offline', message: 'Remote connections are not included in local setup.' });
    const local = await probeLocalDesktopProfile({ id: 'local', name: 'Local', baseUrl: 'http://localhost:4000', kind: 'local' }, async () => {
      throw new Error(`/home/alice/secret ${'x'.repeat(10_000)}`);
    });
    assert.equal(local.status, 'offline');
    assert.ok((local.message?.length ?? 0) < 200);
    assert.doesNotMatch(local.message ?? '', /alice|secret|home/);
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

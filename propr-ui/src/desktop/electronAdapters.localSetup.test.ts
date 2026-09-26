import { describe, expect, it, vi } from 'vitest';
import { createDesktopBridge } from '../../../apps/desktop/src/preload-bridge';
import type { DesktopBridge, DesktopSetupRequest, DesktopSetupSnapshot } from '../../../apps/desktop/src/shared/contract';
import { createElectronDesktopAdapters } from './electronAdapters';

const snapshot: DesktopSetupSnapshot = {
  phase: 'idle',
  capability: { supported: true, kind: 'local', platform: 'linux' },
  sessionId: '11111111-1111-4111-8111-111111111111',
  logs: [],
};

const bridgeFixture = () => {
  const start = vi.fn(async () => snapshot);
  const bridge: DesktopBridge = {
    ...createDesktopBridge({
      invoke: async () => { throw new Error('Unexpected IPC call in local setup adapter fixture'); },
      on: vi.fn(),
      removeListener: vi.fn(),
    }, true),
    localSetup: {
      status: async () => snapshot,
      start,
      retry: async () => snapshot,
      cancel: async () => snapshot,
      selectPrivateKey: async () => null,
      acquireWebhookSecret: async () => null,
      resolveGithubInstallation: async () => snapshot,
      onProgress: () => () => undefined,
    },
  };
  return { bridge, start };
};

describe('Electron guided local setup adapter', () => {
  it('reports real local setup in the production Linux Electron adapter', () => {
    const adapters = createElectronDesktopAdapters(bridgeFixture().bridge);

    expect(adapters.localSetup.supported).toBe(true);
    expect(adapters.discovery.supported).toBe(true);
  });

  it('forwards setup start to the trusted main-process bridge', async () => {
    const fixture = bridgeFixture();
    const adapters = createElectronDesktopAdapters(fixture.bridge);
    const request: DesktopSetupRequest = {
      sessionId: snapshot.sessionId, root: { mode: 'default' }, reinitialize: false,
      agents: ['codex'], github: { mode: 'keep' }, intake: { mode: 'keep' },
      whitelist: null, repository: null,
    };

    await adapters.localSetup.start?.(request);

    expect(fixture.start).toHaveBeenCalledWith(request);
  });
});

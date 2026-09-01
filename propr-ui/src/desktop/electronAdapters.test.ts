import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopRendererBridge } from '../../../apps/desktop/src/shared/contract';
import { getDesktopConnectionScope, setDesktopConnectionScope } from '../api/apiClient';
import { createElectronDesktopAdapters } from './electronAdapters';

const profile = { id: 'remote-1', name: 'Team', baseUrl: 'https://team.example.com', kind: 'remote' as const };

const bridgeFixture = (): DesktopRendererBridge => ({
  isDesktop: true,
  platform: 'macos',
  app: { onDeepLink: () => () => undefined },
  profiles: {
    list: async () => [profile],
    save: async () => undefined,
    remove: async () => undefined,
    getActiveId: async () => null,
    setActiveId: async () => undefined,
  },
  discovery: { discover: async () => [] },
  authentication: { authenticate: async () => undefined, cancel: async () => undefined },
  externalBrowser: { open: async () => undefined },
  localSetup: {
    status: async () => ({
      phase: 'unsupported',
      capability: { supported: false, kind: 'remote-only', platform: 'darwin', reason: 'remote only' },
      sessionId: '00000000-0000-4000-8000-000000000000',
      logs: [],
    }),
    start: async () => { throw new Error('unavailable'); },
    retry: async () => { throw new Error('unavailable'); },
    cancel: async () => { throw new Error('unavailable'); },
    selectPrivateKey: async () => null,
    acquireWebhookSecret: async () => null,
    onProgress: () => () => undefined,
  },
  connection: {
    probe: async () => ({ status: 'ready', activationTicket: 'ticket' }),
    activateLocal: async () => ({ status: 'ready', profileId: 'local-1' }),
    discardLocal: async () => ({ discarded: true }),
    activate: async () => ({
      status: 'ready', profileId: profile.id, transportScope: 'S'.repeat(22), identityEpoch: 'E'.repeat(22),
    }),
    discard: async () => ({ discarded: true }),
    invalidate: async () => ({ invalidated: true }),
  },
});

describe('Electron desktop renderer adapter', () => {
  afterEach(() => {
    setDesktopConnectionScope(null);
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('activates an expiring main-owned ticket and publishes only its non-secret transport scope', async () => {
    const bridge = bridgeFixture();
    bridge.connection.activate = vi.fn(bridge.connection.activate);
    const adapters = createElectronDesktopAdapters(bridge);
    const probe = await adapters.connection.probe(profile);
    expect(probe.status).toBe('ready');
    if (probe.status !== 'ready') return;

    const activated = await adapters.connection.activate!(profile, probe);
    expect(bridge.connection.activate).toHaveBeenCalledWith('ticket');
    expect(activated.status).toBe('ready');
    if (activated.status !== 'ready') return;
    expect(activated).not.toHaveProperty('activationTicket');
    adapters.connection.publishActivation!(profile, activated);

    expect(getDesktopConnectionScope()).toMatchObject({
      bridge,
      profileId: profile.id,
      transportScope: 'S'.repeat(22),
    });
    expect(JSON.stringify(activated)).not.toMatch(/bearer|deviceSecret|credentialPath|nativeEvidence|propr_it_/i);
  });

  it('selects a local profile without publishing a bearer transport scope', async () => {
    const local = { id: 'local-1', name: 'This computer', baseUrl: 'http://127.0.0.1:4000', kind: 'local' as const };
    const bridge = bridgeFixture();
    bridge.connection.activateLocal = vi.fn(bridge.connection.activateLocal);
    bridge.connection.probe = vi.fn(async () => ({
      status: 'ready' as const,
      version: '0.8.15',
      localActivationTicket: 'L'.repeat(43),
    }));
    bridge.connection.activate = vi.fn(bridge.connection.activate);
    const adapters = createElectronDesktopAdapters(bridge);
    const probe = await adapters.connection.probe(local);
    expect(probe.status).toBe('ready');
    if (probe.status !== 'ready') return;

    const activated = await adapters.connection.activate!(local, probe);

    expect(activated).toEqual({
      status: 'ready',
      version: '0.8.15',
      localActivationTicket: 'L'.repeat(43),
    });
    expect(bridge.connection.activateLocal).toHaveBeenCalledWith('L'.repeat(43));
    expect(bridge.connection.activate).not.toHaveBeenCalled();
    expect(getDesktopConnectionScope()).toBeNull();
  });

  it('discards activation when the connection attempt is no longer current', async () => {
    const bridge = bridgeFixture();
    bridge.connection.discard = vi.fn(bridge.connection.discard);
    const adapters = createElectronDesktopAdapters(bridge);
    const result = await adapters.connection.activate!(
      profile,
      { status: 'ready', activationTicket: 'ticket' },
      () => false,
    );
    expect(result.status).toBe('authentication-required');
    expect(bridge.connection.discard).toHaveBeenCalledOnce();
    expect(getDesktopConnectionScope()).toBeNull();
  });

  it('rolls back a local selection that becomes stale while trusted activation is in flight', async () => {
    const local = { id: 'local-1', name: 'This computer', baseUrl: 'http://127.0.0.1:4000', kind: 'local' as const };
    const bridge = bridgeFixture();
    let current = true;
    bridge.connection.activateLocal = vi.fn(async ticket => {
      expect(ticket).toBe('L'.repeat(43));
      current = false;
      return { status: 'ready' as const, profileId: local.id };
    });
    bridge.connection.discardLocal = vi.fn(bridge.connection.discardLocal);
    const adapters = createElectronDesktopAdapters(bridge);
    const result = await adapters.connection.activate!(
      local,
      { status: 'ready', localActivationTicket: 'L'.repeat(43) },
      () => current,
    );

    expect(result.status).toBe('offline');
    expect(bridge.connection.discardLocal).toHaveBeenCalledWith('L'.repeat(43));
    expect(getDesktopConnectionScope()).toBeNull();
  });
});

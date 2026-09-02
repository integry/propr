import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_TRANSPORT_SCOPE_QUERY } from '@propr/shared';
import type { DesktopRendererBridge } from '../../../apps/desktop/src/shared/contract';
import {
  createPackagedTransportSmokeHarness,
  staleReconnectQuery,
} from './packagedTransportSmoke';

const smokeMocks = vi.hoisted(() => ({
  activate: vi.fn(),
  getCurrentUser: vi.fn(),
  probe: vi.fn(),
  publishActivation: vi.fn(),
}));

vi.mock('../api/proprApi', () => ({
  getCurrentUser: smokeMocks.getCurrentUser,
}));

vi.mock('./electronAdapters', () => ({
  createElectronDesktopAdapters: () => ({
    connection: {
      activate: smokeMocks.activate,
      probe: smokeMocks.probe,
      publishActivation: smokeMocks.publishActivation,
    },
  }),
}));

const profile = {
  id: 'remote-1',
  name: 'Operations',
  baseUrl: 'https://operations.example.test',
  kind: 'remote' as const,
};

const bridge = {} as DesktopRendererBridge;
const validCurrentUser = {
  id: 'user-1',
  login: 'operator',
  username: 'operator',
  displayName: 'Operations',
  email: null,
  avatarUrl: null,
  role: 'admin',
  permissions: ['instance.manage_settings'],
  authorizationSource: 'local',
};

describe('packaged transport smoke current-user validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    smokeMocks.probe.mockResolvedValue({ status: 'ready', activationTicket: 'ticket' });
    smokeMocks.activate.mockImplementation(async () => ({
      status: 'ready',
      profileId: profile.id,
      transportScope: `scope-${smokeMocks.activate.mock.calls.length}`,
      identityEpoch: `epoch-${smokeMocks.activate.mock.calls.length}`,
    }));
    smokeMocks.getCurrentUser.mockResolvedValue(validCurrentUser);
  });

  it('validates each published activation exactly once with canonical generations 1-3', async () => {
    const order: string[] = [];
    smokeMocks.probe.mockImplementation(async () => {
      order.push('probe');
      return { status: 'ready', activationTicket: 'ticket' };
    });
    smokeMocks.activate.mockImplementation(async () => {
      order.push('activate');
      const activation = smokeMocks.activate.mock.calls.length;
      return {
        status: 'ready',
        profileId: profile.id,
        transportScope: `scope-${activation}`,
        identityEpoch: `epoch-${activation}`,
      };
    });
    smokeMocks.publishActivation.mockImplementation(() => { order.push('publish'); });
    smokeMocks.getCurrentUser.mockImplementation(async ({ scopeGeneration }) => {
      order.push(`current-user-${scopeGeneration}`);
      return validCurrentUser;
    });
    const harness = createPackagedTransportSmokeHarness(bridge);

    await harness.activate(profile);
    await harness.activate(profile);
    await harness.activate(profile);

    expect(smokeMocks.getCurrentUser.mock.calls.map(([options]) => options)).toEqual([
      { scopeGeneration: 1, activeScopePresent: true },
      { scopeGeneration: 2, activeScopePresent: true },
      { scopeGeneration: 3, activeScopePresent: true },
    ]);
    expect(order).toEqual([
      'probe', 'activate', 'publish', 'current-user-1',
      'probe', 'activate', 'publish', 'current-user-2',
      'probe', 'activate', 'publish', 'current-user-3',
    ]);
  });

  it('fails activation when production current-user schema validation rejects', async () => {
    smokeMocks.getCurrentUser.mockRejectedValue(
      new Error('Current-user response schema was invalid.'),
    );
    const harness = createPackagedTransportSmokeHarness(bridge);

    await expect(harness.activate(profile))
      .rejects.toThrow('Current-user response schema was invalid.');

    expect(smokeMocks.publishActivation).toHaveBeenCalledOnce();
    expect(smokeMocks.getCurrentUser).toHaveBeenCalledOnce();
    expect(smokeMocks.getCurrentUser).toHaveBeenCalledWith({
      scopeGeneration: 1,
      activeScopePresent: true,
    });
  });
});

describe('packaged transport smoke scope query', () => {
  it('preserves the recorded stale scope instead of substituting the current scope', () => {
    const recordedStaleScope = 'AAAAAAAAAAAAAAAAAAAAAA';
    const freshCurrentScope = 'BBBBBBBBBBBBBBBBBBBBBB';

    const query = staleReconnectQuery(recordedStaleScope, freshCurrentScope);

    expect(Object.keys(query)).toEqual([DESKTOP_TRANSPORT_SCOPE_QUERY]);
    expect(query[DESKTOP_TRANSPORT_SCOPE_QUERY]).toBe(recordedStaleScope);
    expect(query[DESKTOP_TRANSPORT_SCOPE_QUERY]).not.toBe(freshCurrentScope);
  });

  it('rejects a stale-boundary check without an actual scope rotation', () => {
    expect(() => staleReconnectQuery(
      'AAAAAAAAAAAAAAAAAAAAAA',
      'AAAAAAAAAAAAAAAAAAAAAA',
    )).toThrow('Packaged stale Socket.IO activation was not rotated');
  });
});

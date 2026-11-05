import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../../../apps/desktop/src/shared/contract';
import { createElectronDesktopAdapters } from './electronAdapters';
import { bridgeFixture, storedProfile } from './electronAdapters.test-fixture';
import { getRendererProfileStateGeneration } from './rendererProfileState';

const desktopConnectionState = vi.hoisted(() => ({
  scope: null as null | { bridge: DesktopBridge; profileId: string; transportScope: string },
}));
vi.mock('../api/apiClient', () => ({
  getDesktopConnectionScope: () => desktopConnectionState.scope,
  setDesktopConnectionScope: (scope: typeof desktopConnectionState.scope) => { desktopConnectionState.scope = scope; },
}));

const EPOCH_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const secondProfile = { ...storedProfile, id: 'profile-2', label: 'Second server' };

/**
 * DesktopExperience withdraws main's selection before every connect, so a
 * failed or interrupted attempt restores no account. These cover what that
 * withdrawal means to the next activation's privacy decision.
 */
describe('Electron selection fence before a reconnect', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    desktopConnectionState.scope = null;
  });

  async function connected() {
    const fixture = bridgeFixture();
    await fixture.bridge.profiles.save(secondProfile);
    let target = storedProfile.id;
    // Main commits the activated profile as its active one.
    fixture.activate.mockImplementation(async () => {
      await fixture.bridge.profiles.setActive(target);
      return { status: 'ready' as const, profileId: target, transportScope: `scope-${fixture.activate.mock.calls.length}`, identityEpoch: EPOCH_A };
    });
    const adapters = createElectronDesktopAdapters(fixture.bridge);
    const [first, second] = await adapters.profiles.list();
    const connect = async (profile = first) => {
      target = profile.id;
      const activated = await adapters.connection.activate!(profile, { status: 'ready', activationTicket: `ticket-${profile.id}` });
      if (activated.status === 'ready') adapters.connection.publishActivation!(profile, activated);
      return activated;
    };
    await connect();
    window.sessionStorage.setItem('profile-session', 'identity-a');
    return { fixture, adapters, connect, first, second };
  }

  const expectRetained = (generation: number) => {
    expect(getRendererProfileStateGeneration()).toBe(generation);
    expect(window.sessionStorage.getItem('profile-session')).toBe('identity-a');
  };
  const expectCleared = (generation: number) => {
    expect(getRendererProfileStateGeneration()).toBeGreaterThan(generation);
    expect(window.sessionStorage.getItem('profile-session')).toBeNull();
  };

  it('persists no selection yet keeps renderer state when the same identity is reconnected', async () => {
    const { fixture, adapters, connect, first } = await connected();
    const generation = getRendererProfileStateGeneration();

    await adapters.connection.fenceSelection!(first.id);
    expect((await fixture.bridge.profiles.list()).activeProfileId).toBeNull();
    expect(desktopConnectionState.scope).toBeNull();
    expect(await connect()).toEqual(expect.objectContaining({ status: 'ready', identityEpoch: EPOCH_A }));
    expectRetained(generation);
  });

  it('keeps the fence across a failed attempt of the same profile', async () => {
    const { adapters, connect, first } = await connected();
    const generation = getRendererProfileStateGeneration();

    await adapters.connection.fenceSelection!(first.id);
    // The probe failed: nothing was activated, and the user retries.
    await adapters.connection.fenceSelection!(first.id);
    await connect();
    expectRetained(generation);
  });

  it('clears renderer state after a plain deselection, as going back to the instance chooser does', async () => {
    const { adapters, connect, first } = await connected();
    const generation = getRendererProfileStateGeneration();

    await adapters.profiles.setActiveId(null);
    await adapters.connection.fenceSelection!(first.id);
    await connect();
    expectCleared(generation);
  });

  it('clears renderer state when the fence was for another profile', async () => {
    const { adapters, connect, first, second } = await connected();
    const generation = getRendererProfileStateGeneration();

    await adapters.connection.fenceSelection!(second.id);
    await adapters.connection.fenceSelection!(first.id);
    await connect();
    expectCleared(generation);
  });

  it('clears renderer state when another profile is activated after the fence', async () => {
    const { adapters, connect, second } = await connected();
    const generation = getRendererProfileStateGeneration();

    await adapters.connection.fenceSelection!(second.id);
    await connect(second);
    expectCleared(generation);
  });

  it('clears renderer state when a saved profile was removed in between', async () => {
    const { adapters, connect, first, second } = await connected();
    const generation = getRendererProfileStateGeneration();

    await adapters.connection.fenceSelection!(first.id);
    await adapters.profiles.remove(second.id);
    await connect();
    expectCleared(generation);
  });

  it('still clears for a replaced credential behind the same fenced profile', async () => {
    const { fixture, adapters, connect, first } = await connected();
    const generation = getRendererProfileStateGeneration();

    await adapters.connection.fenceSelection!(first.id);
    fixture.activate.mockResolvedValueOnce({
      status: 'ready', profileId: first.id, transportScope: 'scope-b', identityEpoch: 'BBBBBBBBBBBBBBBBBBBBBB',
    });
    await connect();
    expectCleared(generation);
  });

  it('never fences a profile this renderer has not published', async () => {
    const fixture = bridgeFixture();
    const adapters = createElectronDesktopAdapters(fixture.bridge);
    const [profile] = await adapters.profiles.list();
    window.sessionStorage.setItem('profile-session', 'identity-a');
    const generation = getRendererProfileStateGeneration();

    await fixture.bridge.profiles.setActive(profile.id);
    await adapters.connection.fenceSelection!(profile.id);
    await adapters.connection.activate!(profile, { status: 'ready', activationTicket: 'ticket-7' });
    expectCleared(generation);
  });
});

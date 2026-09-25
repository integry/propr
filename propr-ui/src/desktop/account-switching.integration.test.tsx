import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrictMode, useContext, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { TASK_UPDATE } from '@propr/shared';
import { DesktopCredentialService } from '../../../apps/desktop/src/credential-service';
import { ProfileStore } from '../../../apps/desktop/src/profile-store';
import { createDesktopBridge } from '../../../apps/desktop/src/preload-bridge';
import { registerIpcHandlers } from '../../../apps/desktop/src/ipc';
// @ts-expect-error Shared executable HTTP fixture has no declaration file.
import { accounts, createTwoAccountFixture } from '../../../apps/desktop/scripts/two-account-http-fixture.mjs';
import { apiFetch, getProprClient, getDesktopConnectionScope, setDesktopConnectionScope } from '../api/apiClient';
import { logout } from '../api/proprApi';
import { SocketProvider } from '../contexts/SocketProvider';
import { SocketContext } from '../contexts/SocketContext';
import { AuthProvider } from '../contexts/AuthContext';
import type { CurrentUser } from '../api/proprTypes';
import { DesktopContext, type DesktopContextValue } from './DesktopContext';
import VoiceBriefingControl from '../components/VoiceBriefingControl';
import VoiceSettingsSection from '../pages/SettingsPage/VoiceSettingsSection';
import SettingsNavigation from '../pages/SettingsPage/SettingsNavigation';
import { DESKTOP_LOGGED_OUT_EVENT } from './types';

vi.mock('../config/runtimeMode', async importOriginal => ({
  ...await importOriginal<typeof import('../config/runtimeMode')>(), isDesktopRuntime: () => true,
}));

it('pairs two users through the production bridge, fences late A traffic, logs B out offline and preserves identity after reload', async () => {
  const fixture = await createTwoAccountFixture();
  const directory = await mkdtemp(join(tmpdir(), 'propr-combined-'));
  // Synthetic storage only; OS keychain and Electron IPC are covered by native smoke.
  const encryption = { isEncryptionAvailable: () => true, backend: () => 'keychain',
    encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() };
  let store = new ProfileStore(directory, encryption);
  const nativeFetch = globalThis.fetch;
  let revocationsOffline = false;
  // Node fetch yields bytes from Node's realm; normalize them for jsdom's
  // strict Uint8Array protocol validator without mocking the HTTP exchange.
  const mainFetch: typeof fetch = async (input, init) => {
    if (revocationsOffline && init?.method === 'DELETE') throw new Error('Synthetic revocation outage');
    const response = await nativeFetch(input, init);
    return new Response(response.body?.pipeThrough(new TransformStream({
      transform(chunk, controller) { controller.enqueue(Uint8Array.from(chunk)); },
    })), { status: response.status, headers: response.headers });
  };
  // Every pairing request, response and validation stays real; only the wait
  // between polls is removed. The protocol floor is one second per pairing and
  // this regression pairs three times, which is dead wall clock inside the
  // budget and buys nothing here. Poll pacing itself is covered by the pairing
  // protocol tests in apps/desktop.
  const service = () => new DesktopCredentialService({ profiles: store, fetch: mainFetch,
    clientName: 'Synthetic combined regression', openPairingBrowser: async () => {}, confirmAccount: async () => true,
    pairingTiming: { sleep: async () => undefined } });
  let credentials = service();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const event = { senderFrame: { url: 'propr-renderer://app/index.html' } };
  const register = () => registerIpcHandlers({
    app: { getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true },
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel) },
    profiles: store, credentials, connectDiscovery: {}, lifecycle: {}, logger: { log() {} },
    desktopSession: { clearStorageData: async () => {} },
    packagedRendererUrl: event.senderFrame.url, openExternal: async () => {},
  } as unknown as Parameters<typeof registerIpcHandlers>[0]);
  let ipc = register();
  const bridge = createDesktopBridge({
    invoke: async (channel, ...args) => structuredClone(await handlers.get(channel)!(event, ...structuredClone(args))),
    on() {}, removeListener() {},
  });
  window.proprDesktop = bridge;
  const alerts = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const loggedOut = vi.fn();
  window.addEventListener(DESKTOP_LOGGED_OUT_EVENT, loggedOut);
  const traffic: string[] = [];
  function Observer() {
    const socket = useContext(SocketContext)!;
    useEffect(() => socket.onTaskUpdate(value => traffic.push((value as unknown as { username: string }).username)), [socket]);
    return null;
  }
  // The two seams below stand in for Electron's IPC/webRequest plumbing. They
  // use the production bridge/handlers and request gate, with real fetch/ws I/O.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const decision = credentials.prepareRequest(String(input), Object.fromEntries(new Headers(init?.headers)),
      { rendererOwned: true, method: init?.method, resourceType: 'xhr' });
    if (decision.cancel) throw new DOMException('Desktop connection changed', 'AbortError');
    return nativeFetch(input, { ...init, headers: decision.requestHeaders as HeadersInit });
  });
  const activate = async (profile: { id: string; label: string; apiBaseUrl: string }) => {
    const probe = await bridge.connection.probe(profile);
    expect(probe.status).toBe('ready');
    if (probe.status !== 'ready') throw new Error('probe failed');
    const scope = await bridge.connection.activate(probe.activationTicket);
    await act(async () => {
      setDesktopConnectionScope({ bridge, ...scope }, fixture.endpoint);
      const client = getProprClient();
      const connect = client.connectSocket.bind(client);
      vi.spyOn(client, 'connectSocket').mockImplementation(options => {
        const socket = connect({ ...options, autoConnect: false });
        const url = new URL('/socket.io/?transport=websocket', fixture.endpoint);
        for (const [key, value] of Object.entries(options?.query ?? {})) url.searchParams.set(key, String(value));
        void credentials.prepareRequestAsync(url.toString(), {}, { rendererOwned: true, resourceType: 'webSocket' }).then(decision => {
          if (decision.cancel) return;
          socket.io.opts.extraHeaders = decision.requestHeaders as Record<string, string>;
          socket.connect();
        });
        return socket;
      });
    });
    return scope;
  };
  let view: ReturnType<typeof render> | undefined;
  try {
    const a = { id: 'account-a', label: 'Team A', apiBaseUrl: fixture.endpoint };
    const b = { ...a, id: 'account-b', label: 'Team B' };
    for (const [index, profile] of [a, b].entries()) {
      fixture.account(accounts[index]);
      const { operationId } = await bridge.authentication.admit(profile.id);
      expect(await bridge.authentication.pair(profile, operationId)).toEqual({ paired: true });
    }
    const credentialA = await store.readCredential(a.id);
    const credentialB = await store.readCredential(b.id);
    expect(credentialA?.token).not.toEqual(credentialB?.token);
    const scopeA = await activate(a);
    view = render(<SocketProvider><Observer /></SocketProvider>);
    await waitFor(() => expect(fixture.io.sockets.sockets.size).toBe(1));
    const socketA = [...fixture.io.sockets.sockets.values()][0] as { emit: (event: string, value: unknown) => void };
    socketA.emit(TASK_UPDATE, accounts[0]);
    await waitFor(() => expect(traffic).toEqual(['alice']));
    traffic.length = 0;
    const lateRest = expect(apiFetch('/api/late-rest')).rejects.toBeDefined();
    const response = await apiFetch('/api/late-body');
    const clone = response.clone();
    const body = expect(response.json()).rejects.toBeDefined();
    const cloneBody = expect(clone.json()).rejects.toBeDefined();
    await waitFor(() => expect(fixture.delayed.size).toBe(2));
    await act(async () => { setDesktopConnectionScope(null); await bridge.profiles.setActive(null); });
    await activate(b);
    socketA.emit(TASK_UPDATE, accounts[0]);
    fixture.release();
    await Promise.all([lateRest, body, cloneBody]);
    expect(traffic).toEqual([]);
    await expect(bridge.auth.logout({ profileId: a.id, transportScope: scopeA.transportScope })).rejects.toThrow();
    expect(await store.readCredential(b.id)).toEqual(credentialB);
    await waitFor(() => expect([...fixture.io.sockets.sockets.values()].some((s: unknown) =>
      (s as { data: { account: { id: string } } }).data.account.id === '202')).toBe(true));
    fixture.io.emit(TASK_UPDATE, accounts[1]);
    await waitFor(() => expect(traffic).toEqual(['bob']));
    expect(await (await apiFetch('/api/current')).json()).toEqual(accounts[1]);
    fixture.offline(true);
    await act(async () => { await logout(); });
    expect(loggedOut).toHaveBeenCalledOnce();
    expect(alerts).not.toHaveBeenCalled();
    expect(getDesktopConnectionScope()).toBeNull();
    await expect(apiFetch('/api/current')).rejects.toThrow('Desktop authentication is required');
    expect(await store.readCredential(b.id)).toBeNull();
    expect(await store.readCredential(a.id)).toEqual(credentialA);
    expect((await store.pendingRevocations()).some(p => p.credential.token === credentialB?.token)).toBe(true);
    view.unmount(); view = undefined;
    ipc.dispose(); await credentials.dispose(); await store.close();
    store = new ProfileStore(directory, encryption); credentials = service(); ipc = register();
    const reloaded = await bridge.profiles.list();
    expect(reloaded.activeProfileId).toBeNull();
    expect(reloaded.profiles.map(p => p.account?.id)).toEqual(['101', '202']);
    fixture.offline(false);
    revocationsOffline = true;
    const recoveredA = await activate(a);
    expect(await (await apiFetch('/api/current')).json()).toEqual(accounts[0]);
    await credentials.awaitIdle();
    expect((await store.pendingRevocations()).map(p => p.credential.token)).toEqual([credentialB?.token]);

    // Reproduce settings acceptance with the real native credential service and
    // bridge. StrictMode also exercises subscription cleanup/remounts. All
    // accounts, storage and HTTP traffic belong to this isolated fixture.
    const desktop = {
      isDesktop: true, platform: 'linux',
      profile: { id: a.id, name: a.label, baseUrl: fixture.endpoint, kind: 'remote' },
      connection: { status: 'ready', transportScope: recoveredA.transportScope },
    } as DesktopContextValue;
    view = render(<StrictMode><DesktopContext.Provider value={desktop}>
      <AuthProvider user={{ ...accounts[0], permissions: [] } as CurrentUser}><MemoryRouter>
        <SettingsNavigation sections={[{
          id: 'voice-briefings', category: 'integrations', searchText: 'voice briefings experimental',
          content: <VoiceSettingsSection />,
        }]} />
        <VoiceBriefingControl />
      </MemoryRouter></AuthProvider>
    </DesktopContext.Provider></StrictMode>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'voice' } });
    const toggle = screen.getByRole('checkbox', { name: 'Enable voice briefings' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(screen.getByRole('button', { name: /Voice briefing/i })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole('button', { name: /Voice briefing/i })).not.toBeInTheDocument();
    expect(getDesktopConnectionScope()?.transportScope).toBe(recoveredA.transportScope);
    expect((await store.list()).activeProfileId).toBe(a.id);
    expect(await store.readCredential(a.id)).toEqual(credentialA);
    expect((await store.pendingRevocations()).map(p => p.credential.token)).toEqual([credentialB?.token]);
    expect(await (await apiFetch('/api/current')).json()).toEqual(accounts[0]);
    view.unmount(); view = undefined;
    expect(loggedOut).toHaveBeenCalledOnce(); // Only the earlier deliberate B logout.
    revocationsOffline = false;
    await credentials.retryPendingRevocations();
    expect(await store.pendingRevocations()).toEqual([]);
    expect(fixture.revoked.has(credentialB?.token)).toBe(true);
    expect(fixture.revoked.has(credentialA?.token)).toBe(false);
    expect(await (await apiFetch('/api/current')).json()).toEqual(accounts[0]);
    fixture.account(accounts[0]);
    const { operationId } = await bridge.authentication.admit(b.id);
    expect(await bridge.authentication.pair(b, operationId)).toMatchObject({ paired: false, code: 'ACCOUNT_MISMATCH' });
    expect(await store.readCredential(b.id)).toBeNull();
    expect(await store.readCredential(a.id)).toEqual(credentialA);
    expect(fixture.revoked.has(credentialA?.token)).toBe(false);
  } finally {
    view?.unmount(); setDesktopConnectionScope(null);
    window.removeEventListener(DESKTOP_LOGGED_OUT_EVENT, loggedOut);
    delete window.proprDesktop; vi.restoreAllMocks();
    ipc.dispose(); await credentials.dispose(); await store.close();
    await fixture.close(); await rm(directory, { recursive: true, force: true });
  }
  // This regression is CPU bound, and the shard it runs in oversubscribes CPU
  // on purpose: rootless workers share a two-CPU quota while Vitest keeps two
  // jsdom workers busy. Measured on a two-CPU quota: ~2s alone, ~8s with four
  // Vitest processes competing, which is already harsher than CI. The budget
  // is sized for that tail, not for the unloaded run. A genuine hang costs the
  // propr-ui shard unit at most this long on top of its ~30s of other files,
  // which keeps it under run-test-suite's 108s timeout-risk warning.
}, 45_000);

import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../api/proprTypes';
import { SocketProvider } from '../contexts/SocketProvider';
import { useCurrentUserBootstrap } from './useCurrentUserBootstrap';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const scopeListeners = vi.hoisted(() => new Set<() => void>());
const state = vi.hoisted(() => ({
  scope: null as null | { bridge: never; profileId: string; transportScope: string },
}));
const getCurrentUser = vi.hoisted(() => vi.fn());
const sockets = vi.hoisted(() => [] as Array<{
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
}>);
const connectSocket = vi.hoisted(() => vi.fn(() => {
  const socket = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
  sockets.push(socket);
  return socket;
}));

vi.mock('../api/proprApi', () => ({
  getCurrentUser,
  INSTANCE_AUTHORIZATION_CHANGED_EVENT: 'propr:instance-authorization-changed',
}));

vi.mock('../api/apiClient', () => ({
  getDesktopConnectionScope: () => state.scope,
  getDesktopSocketConfigurationKey: () =>
    `desktop\u0000https://example.test\u0000${state.scope?.profileId ?? ''}\u0000${state.scope?.transportScope ?? ''}`,
  subscribeDesktopConnectionScope: (listener: () => void) => {
    scopeListeners.add(listener);
    return () => scopeListeners.delete(listener);
  },
  getProprClient: () => ({ connectSocket }),
  handleDesktopAccessCode: vi.fn(async () => 'retryable'),
}));

vi.mock('../config/runtimeMode', () => ({
  currentUiPathname: () => '/',
  isDesktopRuntime: () => true,
}));

const user: CurrentUser = {
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

const publishScope = (scope: typeof state.scope): void => {
  act(() => {
    state.scope = scope;
    scopeListeners.forEach(listener => listener());
  });
};

const activeScope = {
  bridge: {} as never,
  profileId: 'profile-a',
  transportScope: 'AAAAAAAAAAAAAAAAAAAAAA',
};

describe('desktop current-user bootstrap', () => {
  afterEach(() => {
    cleanup();
    state.scope = null;
    scopeListeners.clear();
    getCurrentUser.mockReset();
    connectSocket.mockClear();
    sockets.splice(0);
    vi.restoreAllMocks();
  });

  it('does not let a pre-scope bootstrap suppress or overwrite activation validation', async () => {
    const initial = deferred<CurrentUser>();
    const activated = deferred<CurrentUser>();
    getCurrentUser.mockReturnValueOnce(initial.promise).mockReturnValueOnce(activated.promise);

    const { result } = renderHook(() => useCurrentUserBootstrap({
      isDemoMode: false,
      isDemoModeLoading: false,
    }));
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledOnce());
    expect(getCurrentUser).toHaveBeenNthCalledWith(1, {
      activeScopePresent: false,
      scopeGeneration: 0,
    });

    publishScope(activeScope);
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(2));
    expect(getCurrentUser).toHaveBeenNthCalledWith(2, {
      activeScopePresent: true,
      scopeGeneration: 1,
    });
    expect(result.current.currentUserLoading).toBe(true);

    activated.resolve(user);
    await waitFor(() => expect(result.current.currentUser).toEqual(user));
    expect(result.current.currentUserAbsent).toBe(false);

    initial.reject(new Error('Desktop authentication is required.'));
    await act(async () => { await initial.promise.catch(() => undefined); });
    expect(result.current.currentUser).toEqual(user);

    publishScope(activeScope);
    expect(getCurrentUser).toHaveBeenCalledTimes(2);
  });

  it('rejects an ABA response when the same scope key is republished at a newer generation', async () => {
    const initial = deferred<CurrentUser>();
    const oldA = deferred<CurrentUser>();
    const scopeB = deferred<CurrentUser>();
    const currentA = deferred<CurrentUser>();
    getCurrentUser
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(oldA.promise)
      .mockReturnValueOnce(scopeB.promise)
      .mockReturnValueOnce(currentA.promise);
    const { result } = renderHook(() => useCurrentUserBootstrap({
      isDemoMode: false,
      isDemoModeLoading: false,
    }));
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledOnce());

    publishScope(activeScope);
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(2));
    publishScope({ ...activeScope, profileId: 'profile-b', transportScope: 'BBBBBBBBBBBBBBBBBBBBBB' });
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(3));
    publishScope(activeScope);
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(4));

    oldA.resolve(user);
    await act(async () => { await oldA.promise; });
    expect(result.current.currentUser).toBeNull();

    currentA.resolve(user);
    await waitFor(() => expect(result.current.currentUser).toEqual(user));
    initial.reject(new Error('Desktop authentication is required.'));
    scopeB.reject(new Error('Desktop authentication is required.'));
    await act(async () => { await Promise.allSettled([initial.promise, scopeB.promise]); });
    expect(result.current.currentUser).toEqual(user);
  });

  it('mounts an active scope at generation one and enables exactly one stable Manager after current validation', async () => {
    const mountedA = deferred<CurrentUser>();
    const scopeB = deferred<CurrentUser>();
    const currentA = deferred<CurrentUser>();
    const refreshedA = deferred<CurrentUser>();
    const staleMountedUser = { ...user, id: 'stale-mounted-a' };
    const staleScopeBUser = { ...user, id: 'stale-scope-b' };
    getCurrentUser
      .mockReturnValueOnce(mountedA.promise)
      .mockReturnValueOnce(scopeB.promise)
      .mockReturnValueOnce(currentA.promise)
      .mockReturnValueOnce(refreshedA.promise);
    state.scope = activeScope;

    let latestBootstrap: ReturnType<typeof useCurrentUserBootstrap> | undefined;
    const Harness = () => {
      const bootstrap = useCurrentUserBootstrap({ isDemoMode: false, isDemoModeLoading: false });
      latestBootstrap = bootstrap;
      const disableReasons = {
        demoModeLoading: false,
        demoMode: false,
        currentUserLoading: bootstrap.currentUserLoading,
        currentUserAbsent: bootstrap.currentUserAbsent,
      };
      return (
        <SocketProvider disabled={Object.values(disableReasons).some(Boolean)} disableReasons={disableReasons}>
          <div>app</div>
        </SocketProvider>
      );
    };

    render(<Harness />);
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledOnce());
    expect(getCurrentUser).toHaveBeenNthCalledWith(1, {
      activeScopePresent: true,
      scopeGeneration: 1,
    });
    expect(connectSocket).not.toHaveBeenCalled();

    publishScope({ ...activeScope, profileId: 'profile-b', transportScope: 'BBBBBBBBBBBBBBBBBBBBBB' });
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(2));
    expect(getCurrentUser).toHaveBeenNthCalledWith(2, {
      activeScopePresent: true,
      scopeGeneration: 2,
    });
    publishScope(activeScope);
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(3));
    expect(getCurrentUser).toHaveBeenNthCalledWith(3, {
      activeScopePresent: true,
      scopeGeneration: 3,
    });

    currentA.resolve(user);
    await waitFor(() => expect(latestBootstrap?.currentUser).toEqual(user));
    await waitFor(() => expect(connectSocket).toHaveBeenCalledOnce());
    expect(sockets[0].connect).not.toHaveBeenCalled();

    mountedA.resolve(staleMountedUser);
    scopeB.resolve(staleScopeBUser);
    await act(async () => { await Promise.all([mountedA.promise, scopeB.promise]); });
    expect(latestBootstrap?.currentUser).toEqual(user);
    expect(connectSocket).toHaveBeenCalledOnce();
    expect(sockets[0].connect).not.toHaveBeenCalled();

    act(() => { window.dispatchEvent(new Event('propr:instance-authorization-changed')); });
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(4));
    expect(getCurrentUser).toHaveBeenNthCalledWith(4, {
      activeScopePresent: true,
      scopeGeneration: 3,
    });
    refreshedA.resolve(user);
    await act(async () => { await refreshedA.promise; });
    expect(latestBootstrap?.currentUser).toEqual(user);
    expect(connectSocket).toHaveBeenCalledOnce();
    expect(sockets[0].connect).not.toHaveBeenCalled();
    expect(sockets[0].disconnect).not.toHaveBeenCalled();
  });

  it('waits for demo-mode loading before one active-on-mount validation and Manager in StrictMode', async () => {
    getCurrentUser.mockResolvedValue(user);
    state.scope = activeScope;

    const Harness = ({ isDemoModeLoading }: { isDemoModeLoading: boolean }) => {
      const bootstrap = useCurrentUserBootstrap({ isDemoMode: false, isDemoModeLoading });
      const disableReasons = {
        demoModeLoading: isDemoModeLoading,
        demoMode: false,
        currentUserLoading: bootstrap.currentUserLoading,
        currentUserAbsent: bootstrap.currentUserAbsent,
      };
      return (
        <SocketProvider disabled={Object.values(disableReasons).some(Boolean)} disableReasons={disableReasons}>
          <div>app</div>
        </SocketProvider>
      );
    };

    const { rerender } = render(
      <StrictMode>
        <Harness isDemoModeLoading />
      </StrictMode>,
    );

    // Let an immediately resolved local validation fully settle if an effect
    // incorrectly owns active-scope bootstrap while demo mode is still loading.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(connectSocket).not.toHaveBeenCalled();

    rerender(
      <StrictMode>
        <Harness isDemoModeLoading={false} />
      </StrictMode>,
    );

    await waitFor(() => expect(connectSocket).toHaveBeenCalledOnce());
    expect(getCurrentUser).toHaveBeenCalledOnce();
    expect(getCurrentUser).toHaveBeenCalledWith({
      activeScopePresent: true,
      scopeGeneration: 1,
    });
    expect(sockets).toHaveLength(1);
    expect(sockets[0].connect).not.toHaveBeenCalled();
  });

  it('constructs once after activated validation and removes that Manager when revalidation fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getCurrentUser
      .mockRejectedValueOnce(new Error('Desktop authentication is required.'))
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce(user)
      .mockRejectedValueOnce(new Error('This desktop connection was revoked or expired.'));

    let latestBootstrap: ReturnType<typeof useCurrentUserBootstrap> | undefined;
    const Harness = () => {
      const bootstrap = useCurrentUserBootstrap({ isDemoMode: false, isDemoModeLoading: false });
      latestBootstrap = bootstrap;
      const disableReasons = {
        demoModeLoading: false,
        demoMode: false,
        currentUserLoading: bootstrap.currentUserLoading,
        currentUserAbsent: bootstrap.currentUserAbsent,
      };
      return (
        <SocketProvider disabled={Object.values(disableReasons).some(Boolean)} disableReasons={disableReasons}>
          <div>app</div>
        </SocketProvider>
      );
    };

    render(<Harness />);
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledOnce());
    await waitFor(() => expect(latestBootstrap?.isInitialLoading).toBe(false));
    expect(latestBootstrap?.currentUserAbsent).toBe(true);
    expect(connectSocket).not.toHaveBeenCalled();

    publishScope(activeScope);
    await waitFor(() => expect(connectSocket).toHaveBeenCalledOnce());
    expect(sockets[0].connect).not.toHaveBeenCalled();

    act(() => { window.dispatchEvent(new Event('propr:instance-authorization-changed')); });
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(3));
    expect(connectSocket).toHaveBeenCalledOnce();
    expect(sockets[0].connect).not.toHaveBeenCalled();
    expect(sockets[0].disconnect).not.toHaveBeenCalled();

    act(() => { window.dispatchEvent(new Event('propr:instance-authorization-changed')); });
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(sockets[0].disconnect).toHaveBeenCalledOnce());
    expect(connectSocket).toHaveBeenCalledOnce();
  });
});

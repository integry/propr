import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
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
  proprClient: { connectSocket },
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

    publishScope(activeScope);
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(2));
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

  it('constructs once after activated validation and removes that Manager when revalidation fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getCurrentUser
      .mockRejectedValueOnce(new Error('Desktop authentication is required.'))
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
    expect(sockets[0].connect).toHaveBeenCalledOnce();

    act(() => { window.dispatchEvent(new Event('propr:instance-authorization-changed')); });
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(sockets[0].disconnect).toHaveBeenCalledOnce());
    expect(connectSocket).toHaveBeenCalledOnce();
  });
});

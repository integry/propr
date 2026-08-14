import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, type InitialEntry } from 'react-router-dom';
import { HostedFlowRouteSync } from '../App';
import LoginPage, { navigateToDemoEntry } from './LoginPage';
import { getCurrentUser } from '../api/proprApi';
import type { CurrentUser } from '../api/proprTypes';
import {
  activateStoredHostedTunnelFlow,
  HOSTED_TUNNEL_FLOW_ID_KEY,
  resolveApiBaseUrl,
} from '../config/runtimeConfig';

const runtimeConfigMockState = vi.hoisted(() => ({
  activeApiBaseUrl: 'https://t-testactive.propr.dev',
  forceHostedUiOrigin: false,
}));

vi.mock('../config/runtimeConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/runtimeConfig')>();
  return {
    ...actual,
    isHostedUiOrigin: vi.fn((hostname: string) => (
      runtimeConfigMockState.forceHostedUiOrigin || actual.isHostedUiOrigin(hostname)
    )),
    getApiBaseUrl: vi.fn(() => runtimeConfigMockState.activeApiBaseUrl),
    pathWithActiveHostedTunnelFlow: vi.fn((path: string, hostname?: string, flowId?: string | null) => (
      actual.pathWithActiveHostedTunnelFlow(
        path,
        runtimeConfigMockState.forceHostedUiOrigin && hostname === undefined ? 'app.propr.dev' : hostname,
        flowId
      )
    )),
  };
});

vi.mock('../hooks/useDocumentTitle', () => ({
  useDocumentTitle: vi.fn(),
}));

const demoState = { isDemoMode: false, isLoading: false };
vi.mock('../contexts/DemoModeContext', () => ({
  useDemoMode: () => demoState,
}));

vi.mock('../api/proprApi', () => ({
  API_BASE_URL: '',
  getCurrentUser: vi.fn(),
}));

const mockGetCurrentUser = vi.mocked(getCurrentUser);

const authenticatedUser: CurrentUser = {
  id: '100',
  login: 'owner',
  username: 'owner',
  displayName: 'Owner',
  email: null,
  avatarUrl: null,
  role: 'admin',
  permissions: [],
  authorizationSource: 'local',
};

const LocationProbe = () => {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>;
};

const renderLogin = (entry: InitialEntry) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <LocationProbe />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/plans" element={<div>plans page</div>} />
        <Route path="/" element={<div>dashboard</div>} />
      </Routes>
    </MemoryRouter>
  );

const renderLoginWithHostedFlowRouteSync = (entry: InitialEntry) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <HostedFlowRouteSync hostname="app.propr.dev" />
      <LocationProbe />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/plans" element={<div>plans page</div>} />
        <Route path="/" element={<div>dashboard</div>} />
      </Routes>
    </MemoryRouter>
  );

const memoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
};

describe('LoginPage session recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    runtimeConfigMockState.forceHostedUiOrigin = false;
    activateStoredHostedTunnelFlow('app.propr.dev', '', memoryStorage(), 'empty-context');
    demoState.isDemoMode = false;
    demoState.isLoading = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('redirects to the previous page when /api/auth/user succeeds', async () => {
    mockGetCurrentUser.mockResolvedValue(authenticatedUser);

    renderLogin({ pathname: '/login', state: { from: '/plans' } });

    await waitFor(() => {
      expect(screen.getByText('plans page')).toBeInTheDocument();
    });
    expect(mockGetCurrentUser).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Sign in with GitHub')).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/plans');
  });

  it('falls back to the dashboard for an external redirect_to query param', async () => {
    mockGetCurrentUser.mockResolvedValue(authenticatedUser);

    renderLogin('/login?redirect_to=https%3A%2F%2Fevil.example');

    await waitFor(() => {
      expect(screen.getByText('dashboard')).toBeInTheDocument();
    });
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('falls back to the dashboard for a protocol-relative redirect_to query param', async () => {
    mockGetCurrentUser.mockResolvedValue(authenticatedUser);

    renderLogin('/login?redirect_to=%2F%2Fevil.example');

    await waitFor(() => {
      expect(screen.getByText('dashboard')).toBeInTheDocument();
    });
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('falls back to the dashboard for an external router state return path', async () => {
    mockGetCurrentUser.mockResolvedValue(authenticatedUser);

    renderLogin({ pathname: '/login', state: { from: 'https://evil.example' } });

    await waitFor(() => {
      expect(screen.getByText('dashboard')).toBeInTheDocument();
    });
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('uses object-shaped router state with pathname, search, and hash', async () => {
    mockGetCurrentUser.mockResolvedValue(authenticatedUser);

    renderLogin({
      pathname: '/login',
      state: { from: { pathname: '/plans', search: '?tab=active', hash: '#details' } },
    });

    await waitFor(() => {
      expect(screen.getByText('plans page')).toBeInTheDocument();
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/plans?tab=active#details');
  });

  it('falls back to the dashboard for return paths containing backslashes', async () => {
    mockGetCurrentUser.mockResolvedValue(authenticatedUser);

    renderLogin({ pathname: '/login', state: { from: '/plans\\evil' } });

    await waitFor(() => {
      expect(screen.getByText('dashboard')).toBeInTheDocument();
    });
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('keeps the login button visible when the auth check fails', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('Authentication required'));

    renderLogin('/login');

    await waitFor(() => {
      expect(screen.getByText('Sign in with GitHub')).toBeInTheDocument();
    });
    expect(mockGetCurrentUser).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location')).toHaveTextContent('/login');
  });

  it('skips the session recovery check after an explicit logout', async () => {
    mockGetCurrentUser.mockResolvedValue(authenticatedUser);

    renderLogin('/login?logged_out=true');

    await waitFor(() => {
      expect(screen.getByText('Sign in with GitHub')).toBeInTheDocument();
    });
    expect(screen.getByText('You have been successfully logged out.')).toBeInTheDocument();
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
  });

  it('shows an accessible status indicator while checking the current session', () => {
    demoState.isLoading = true;

    renderLogin('/login');

    expect(screen.getByRole('status', { name: 'Checking session' })).toBeInTheDocument();
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
  });

  it('shows a clear error and does not fall back to same-tab hosted OAuth when popups are blocked', async () => {
    runtimeConfigMockState.forceHostedUiOrigin = true;
    mockGetCurrentUser.mockRejectedValue(new Error('Authentication required'));
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const originalHref = window.location.href;

    renderLogin('/login');

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(originalHref);
    expect(
      await screen.findByText('GitHub sign-in could not open. Allow popups for this site, then try again.')
    ).toBeInTheDocument();
  });

  it('polls the hosted parent tunnel, closes the popup on success, and preserves the safe return query and hash', async () => {
    runtimeConfigMockState.forceHostedUiOrigin = true;
    mockGetCurrentUser
      .mockRejectedValueOnce(new Error('Authentication required'))
      .mockResolvedValue(authenticatedUser);
    const popup = { closed: false, close: vi.fn(function close(this: { closed: boolean }) { this.closed = true; }) } as unknown as Window;
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    vi.spyOn(window, 'open').mockReturnValue(popup);

    renderLogin({
      pathname: '/login',
      state: { from: { pathname: '/plans', search: '?status=open&flow=attacker', hash: '#details' } },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));

    await waitFor(() => {
      expect(screen.getByText('plans page')).toBeInTheDocument();
    });
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent('/plans?status=open#details');
  });

  it('returns to router state.from after hosted flow insertion and popup completion', async () => {
    runtimeConfigMockState.forceHostedUiOrigin = true;
    mockGetCurrentUser
      .mockRejectedValueOnce(new Error('Authentication required'))
      .mockResolvedValue(authenticatedUser);
    const popup = { closed: false, close: vi.fn(function close(this: { closed: boolean }) { this.closed = true; }) } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);

    const storage = memoryStorage();
    resolveApiBaseUrl(
      'app.propr.dev',
      '?tunnel=t-loginstate.propr.dev',
      undefined,
      undefined,
      storage,
      'login-state-context'
    );
    const flowId = storage.setItem.mock.calls.find(([key]) => key === HOSTED_TUNNEL_FLOW_ID_KEY)?.[1];

    renderLoginWithHostedFlowRouteSync({
      pathname: '/login',
      state: { from: { pathname: '/plans', search: '?status=open&sort=updated', hash: '#details' } },
    });

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(`/login?flow=${flowId}`);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));

    await waitFor(() => {
      expect(screen.getByText('plans page')).toBeInTheDocument();
    });
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/plans?status=open&sort=updated&flow=${flowId}#details`
    );
  });

  it('stops hosted polling when the popup closes before authentication completes', async () => {
    runtimeConfigMockState.forceHostedUiOrigin = true;
    mockGetCurrentUser.mockRejectedValue(new Error('Authentication required'));
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);

    renderLogin('/login');

    const loginButton = await screen.findByRole('button', { name: 'Sign in with GitHub' });
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    fireEvent.click(loginButton);
    expect(screen.getByRole('button', { name: 'Waiting for GitHub...' })).toBeDisabled();

    Object.defineProperty(popup, 'closed', { value: true, configurable: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(screen.getByText('The GitHub sign-in window was closed before login completed. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).not.toBeDisabled();
  });

  it('closes hosted popup and ignores an in-flight poll completion after unmount', async () => {
    runtimeConfigMockState.forceHostedUiOrigin = true;
    let resolvePendingUser: (user: CurrentUser) => void = () => {};
    const pendingUser = new Promise<CurrentUser>((resolve) => {
      resolvePendingUser = resolve;
    });
    mockGetCurrentUser
      .mockRejectedValueOnce(new Error('Authentication required'))
      .mockReturnValueOnce(pendingUser);
    const popup = { closed: false, close: vi.fn(function close(this: { closed: boolean }) { this.closed = true; }) } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const Harness = ({ showLogin }: { showLogin: boolean }) => (
      <MemoryRouter initialEntries={[{ pathname: '/login', state: { from: '/plans' } }]}>
        <LocationProbe />
        <Routes>
          <Route path="/login" element={showLogin ? <LoginPage /> : <div>login removed</div>} />
          <Route path="/plans" element={<div>plans page</div>} />
        </Routes>
      </MemoryRouter>
    );

    const { rerender } = render(<Harness showLogin />);
    const loginButton = await screen.findByRole('button', { name: 'Sign in with GitHub' });
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');

    fireEvent.click(loginButton);
    expect(mockGetCurrentUser).toHaveBeenCalledTimes(2);

    rerender(<Harness showLogin={false} />);

    expect(screen.getByText('login removed')).toBeInTheDocument();
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePendingUser(authenticatedUser);
      await pendingUser;
    });

    expect(screen.getByTestId('location')).toHaveTextContent('/login');
    expect(screen.queryByText('plans page')).not.toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('does not authorize a copied blank-name context before, during, or after another hosted tab starts OAuth', async () => {
    runtimeConfigMockState.forceHostedUiOrigin = true;
    mockGetCurrentUser
      .mockRejectedValueOnce(new Error('Authentication required'))
      .mockResolvedValue(authenticatedUser);
    const openPopup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(openPopup);

    const storage = memoryStorage();
    resolveApiBaseUrl('app.propr.dev', '?tunnel=t-parent.propr.dev', undefined, undefined, storage, 'parent-context');
    const flowId = storage.getItem(HOSTED_TUNNEL_FLOW_ID_KEY);
    const copiedStorage = memoryStorage({
      'propr.hostedTunnelApiBaseUrl': 'https://t-parent.propr.dev',
      'propr.hostedTunnelContextId': 'parent-context',
      [HOSTED_TUNNEL_FLOW_ID_KEY]: flowId || '',
    });

    expect(resolveApiBaseUrl('app.propr.dev', `?flow=${flowId}`, undefined, undefined, copiedStorage, null)).toBe('');

    renderLogin('/login');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));
    expect(resolveApiBaseUrl('app.propr.dev', `?flow=${flowId}`, undefined, undefined, copiedStorage, null)).toBe('');

    await waitFor(() => {
      expect(screen.getByText('dashboard')).toBeInTheDocument();
    });
    expect(resolveApiBaseUrl('app.propr.dev', `?flow=${flowId}`, undefined, undefined, copiedStorage, null)).toBe('');
  });

  it('does not carry a raw attacker flow into the demo-entry navigation when no active flow exists', () => {
    runtimeConfigMockState.forceHostedUiOrigin = true;
    activateStoredHostedTunnelFlow('app.propr.dev', '', memoryStorage(), 'empty-context');
    const targetWindow = {
      location: {
        hostname: 'app.propr.dev',
        href: 'https://app.propr.dev/login?flow=attacker',
      },
    };

    navigateToDemoEntry(targetWindow);

    expect(targetWindow.location.href).toBe('/');
  });

  it('retains the validated active flow in the hosted demo-entry full-page navigation', () => {
    runtimeConfigMockState.forceHostedUiOrigin = true;
    const storage = memoryStorage();
    resolveApiBaseUrl(
      'app.propr.dev',
      '?tunnel=t-demoentry.propr.dev',
      undefined,
      undefined,
      storage,
      'demo-entry-context'
    );
    const flowId = storage.setItem.mock.calls.find(([key]) => key === HOSTED_TUNNEL_FLOW_ID_KEY)?.[1];
    const targetWindow = {
      location: {
        hostname: 'app.propr.dev',
        href: 'https://app.propr.dev/login',
      },
    };

    navigateToDemoEntry(targetWindow);

    expect(targetWindow.location.href).toBe(`/?flow=${flowId}`);
  });

  it('keeps local demo-entry navigation unchanged even when a hosted flow is active', () => {
    const storage = memoryStorage();
    resolveApiBaseUrl(
      'app.propr.dev',
      '?tunnel=t-local-demoentry.propr.dev',
      undefined,
      undefined,
      storage,
      'local-demo-entry-context'
    );
    const targetWindow = {
      location: {
        hostname: 'localhost',
        href: 'http://localhost/login',
      },
    };

    navigateToDemoEntry(targetWindow);

    expect(targetWindow.location.href).toBe('/');
  });
});

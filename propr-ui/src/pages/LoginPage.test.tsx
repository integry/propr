import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, type InitialEntry } from 'react-router-dom';
import { HostedFlowRouteSync } from '../App';
import LoginPage, { buildGithubOAuthUrl } from './LoginPage';
import { getCurrentUser } from '../api/proprApi';
import type { CurrentUser } from '../api/proprTypes';
import {
  activateStoredHostedTunnelFlow,
  HOSTED_TUNNEL_FLOW_ID_KEY,
  pathWithActiveHostedTunnelFlow,
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

const redirectToFor = (oauthUrl: string): string | null => new URL(oauthUrl).searchParams.get('redirect_to');

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

  it('builds hosted popup OAuth with an inert completion target while the parent keeps the safe route flow', () => {
    const storage = memoryStorage();
    resolveApiBaseUrl(
      'app.propr.dev',
      '?tunnel=t-oauth123.propr.dev',
      undefined,
      undefined,
      storage,
      'oauth-context'
    );
    const flowId = storage.setItem.mock.calls.find(([key]) => key === HOSTED_TUNNEL_FLOW_ID_KEY)?.[1];

    expect(pathWithActiveHostedTunnelFlow('/login?flow=attacker', 'app.propr.dev')).toBe(
      `/login?flow=${flowId}`
    );
    expect(
      pathWithActiveHostedTunnelFlow(
        '/tasks?status=open&sort=updated&flow=attacker&flow=other#details',
        'app.propr.dev'
      )
    ).toBe(`/tasks?status=open&sort=updated&flow=${flowId}#details`);

    const oauthUrl = buildGithubOAuthUrl(
      '/tasks?status=open&sort=updated&flow=attacker&flow=other#details',
      'https://app.propr.dev',
      'https://t-oauth123.propr.dev',
      'app.propr.dev',
      { hostedPopupCompletion: true, activeApiBaseUrl: 'https://t-oauth123.propr.dev' }
    );
    const redirectTo = redirectToFor(oauthUrl);

    expect(new URL(oauthUrl).origin).toBe('https://t-oauth123.propr.dev');
    expect(new URL(oauthUrl).pathname).toBe('/api/auth/github');
    expect(redirectTo).toBe('https://app.propr.dev/login?oauth_complete=true');
    expect(redirectTo).not.toContain('flow=');
    expect(redirectTo).not.toContain('t-oauth123.propr.dev');
  });

  it.each([
    ['javascript URL', 'javascript:alert(1)'],
    ['data URL', 'data:text/html,<script>alert(1)</script>'],
    ['protocol-relative URL', '//evil.example/path'],
    ['backslash path', '/plans\\evil'],
    ['control-character path', '/plans\nnext'],
  ])('falls back to / for an unsafe %s return path at the OAuth boundary', (_name, returnPath) => {
    const oauthUrl = buildGithubOAuthUrl(
      returnPath,
      'https://app.propr.dev',
      'https://app.propr.dev',
      'app.propr.dev'
    );

    expect(redirectToFor(oauthUrl)).toBe('https://app.propr.dev/');
  });

  it.each([
    ['malformed OAuth base', 'not a url'],
    ['managed tunnel with path', 'https://t-oauth123.propr.dev/base'],
    ['non-http OAuth base', 'ftp://localhost'],
  ])('rejects a %s before producing a navigation target', (_name, oauthApiUrl) => {
    expect(() =>
      buildGithubOAuthUrl('/plans?status=open#details', 'https://app.propr.dev', oauthApiUrl, 'app.propr.dev')
    ).toThrow();
  });

  it('builds a legitimate local API OAuth URL through URLSearchParams', () => {
    const oauthUrl = buildGithubOAuthUrl(
      '/plans?status=open&filter=mine#details',
      'http://localhost:5173',
      'http://localhost:4000',
      'localhost'
    );
    const url = new URL(oauthUrl);

    expect(url.origin).toBe('http://localhost:4000');
    expect(url.pathname).toBe('/api/auth/github');
    expect(redirectToFor(oauthUrl)).toBe('http://localhost:5173/plans?status=open&filter=mine#details');
  });

  it('builds a legitimate configured split-origin OAuth URL for local/self-hosted builds', () => {
    const oauthUrl = buildGithubOAuthUrl(
      '/settings?tab=members#invite',
      'https://ui-preview.gitfix.dev',
      'https://api.gitfix.dev',
      'ui-preview.gitfix.dev'
    );
    const url = new URL(oauthUrl);

    expect(url.origin).toBe('https://api.gitfix.dev');
    expect(url.pathname).toBe('/api/auth/github');
    expect(redirectToFor(oauthUrl)).toBe('https://ui-preview.gitfix.dev/settings?tab=members#invite');
  });

  it('builds a legitimate hosted managed tunnel OAuth URL only for the exact active tunnel', () => {
    const oauthUrl = buildGithubOAuthUrl(
      '/settings?tab=members&sort=asc#invite',
      'https://app.propr.dev',
      'https://t-managed123.propr.dev',
      'app.propr.dev',
      { hostedPopupCompletion: true, activeApiBaseUrl: 'https://t-managed123.propr.dev' }
    );
    const url = new URL(oauthUrl);

    expect(url.origin).toBe('https://t-managed123.propr.dev');
    expect(url.pathname).toBe('/api/auth/github');
    expect(redirectToFor(oauthUrl)).toBe('https://app.propr.dev/login?oauth_complete=true');
  });

  it.each([
    ['foreign configured origin', 'https://api.example.com', 'https://t-managed123.propr.dev'],
    ['other managed tunnel', 'https://t-other456.propr.dev', 'https://t-managed123.propr.dev'],
    ['non-managed active API origin', 'https://t-managed123.propr.dev', 'https://api.example.com'],
  ])('rejects hosted OAuth when %s would not bind to the active tunnel', (_name, oauthApiUrl, activeApiBaseUrl) => {
    expect(() =>
      buildGithubOAuthUrl(
        '/settings?tab=members#invite',
        'https://app.propr.dev',
        oauthApiUrl,
        'app.propr.dev',
        { hostedPopupCompletion: true, activeApiBaseUrl }
      )
    ).toThrow();
  });

  it('keeps local same-tab login behavior unchanged', () => {
    const oauthUrl = buildGithubOAuthUrl(
      '/plans?status=open#details',
      'http://localhost:5173',
      'http://localhost:4000',
      'localhost',
      { hostedPopupCompletion: true }
    );

    expect(new URL(oauthUrl).origin).toBe('http://localhost:4000');
    expect(redirectToFor(oauthUrl)).toBe('http://localhost:5173/plans?status=open#details');
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
});

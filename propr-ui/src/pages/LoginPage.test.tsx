import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, type InitialEntry } from 'react-router-dom';
import LoginPage, { buildGithubOAuthUrl } from './LoginPage';
import { getCurrentUser } from '../api/proprApi';
import type { CurrentUser } from '../api/proprTypes';
import {
  activateStoredHostedTunnelFlow,
  HOSTED_TUNNEL_FLOW_ID_KEY,
  pathWithActiveHostedTunnelFlow,
  resolveApiBaseUrl,
} from '../config/runtimeConfig';

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
    activateStoredHostedTunnelFlow('app.propr.dev', '', memoryStorage(), 'empty-context');
    demoState.isDemoMode = false;
    demoState.isLoading = false;
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

  it('builds an OAuth redirect_to with exactly the validated active hosted flow', () => {
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

    const oauthUrl = buildGithubOAuthUrl(
      '/tasks?status=open&sort=updated&flow=attacker&flow=other#details',
      'https://app.propr.dev',
      'https://t-oauth123.propr.dev',
      'app.propr.dev'
    );
    const redirectTo = redirectToFor(oauthUrl);

    expect(new URL(oauthUrl).origin).toBe('https://t-oauth123.propr.dev');
    expect(new URL(oauthUrl).pathname).toBe('/api/auth/github');
    expect(redirectTo).toBe(`https://app.propr.dev/tasks?status=open&sort=updated&flow=${flowId}#details`);
    expect(redirectTo?.match(/[?&]flow=/g)).toHaveLength(1);
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
    ['foreign OAuth base', 'https://evil.example'],
    ['foreign ProPR subdomain', 'https://auth.propr.dev'],
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

  it('builds a legitimate managed tunnel OAuth URL', () => {
    const oauthUrl = buildGithubOAuthUrl(
      '/settings?tab=members&sort=asc#invite',
      'https://app.propr.dev',
      'https://t-managed123.propr.dev',
      'app.propr.dev'
    );
    const url = new URL(oauthUrl);

    expect(url.origin).toBe('https://t-managed123.propr.dev');
    expect(url.pathname).toBe('/api/auth/github');
    expect(redirectToFor(oauthUrl)).toBe('https://app.propr.dev/settings?tab=members&sort=asc#invite');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGithubOAuthUrl } from './LoginPage';
import {
  activateStoredHostedTunnelFlow,
  HOSTED_TUNNEL_FLOW_ID_KEY,
  pathWithActiveHostedTunnelFlow,
  resolveApiBaseUrl,
} from '../config/runtimeConfig';

vi.mock('../hooks/useDocumentTitle', () => ({
  useDocumentTitle: vi.fn(),
}));

vi.mock('../contexts/DemoModeContext', () => ({
  useDemoMode: () => ({ isDemoMode: false, isLoading: false }),
}));

vi.mock('../api/proprApi', () => ({
  API_BASE_URL: '',
  getCurrentUser: vi.fn(),
}));

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

describe('buildGithubOAuthUrl', () => {
  beforeEach(() => {
    activateStoredHostedTunnelFlow('app.propr.dev', '', memoryStorage(), 'empty-context');
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
});

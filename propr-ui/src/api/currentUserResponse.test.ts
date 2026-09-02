import { afterEach, describe, expect, it, vi } from 'vitest';
import { PACKAGED_ACCEPTANCE_CURRENT_USER_PREFIX } from '../desktop/packagedAcceptanceCurrentUserValidation';
import { getCurrentUser, isCurrentUserResponse } from './proprApi';

const apiFetch = vi.hoisted(() => vi.fn());

vi.mock('./apiClient', () => ({
  API_BASE_URL: 'https://example.test',
  apiFetch,
  handleApiResponse: vi.fn(async (response: Response) => response),
}));

type AcceptanceWindow = Window & { __PROPR_PACKAGED_ACCEPTANCE__?: unknown };

const validUser = {
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

describe('current-user response schema', () => {
  afterEach(() => {
    apiFetch.mockReset();
    delete (window as AcceptanceWindow).__PROPR_PACKAGED_ACCEPTANCE__;
    vi.restoreAllMocks();
  });

  it('accepts the authenticated instance-user contract', () => {
    expect(isCurrentUserResponse(validUser)).toBe(true);
  });

  it('rejects missing identity, unknown permissions, and unauthenticated bodies', () => {
    expect(isCurrentUserResponse({ ...validUser, id: undefined })).toBe(false);
    expect(isCurrentUserResponse({ ...validUser, permissions: ['instance.unknown'] })).toBe(false);
    expect(isCurrentUserResponse({ code: 'INVALID_INSTANCE_TOKEN' })).toBe(false);
  });

  it('reports fixed accepted and rejected parse outcomes for an active scope', async () => {
    (window as AcceptanceWindow).__PROPR_PACKAGED_ACCEPTANCE__ = {};
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(validUser), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));

    await expect(getCurrentUser({ scopeGeneration: 3, activeScopePresent: true })).resolves.toEqual(validUser);
    expect(info.mock.calls.map(call => call[1])).toEqual([
      expect.objectContaining({ phase: 'request-issued', scopeGeneration: 3, classification: 'pending' }),
      expect.objectContaining({ phase: 'response-completed', responseStatus: 200, classification: 'success' }),
      expect.objectContaining({ phase: 'parsed-user-accepted', scopeGeneration: 3, schemaAccepted: true }),
    ]);
    expect(info.mock.calls.every(call => call[0] === PACKAGED_ACCEPTANCE_CURRENT_USER_PREFIX)).toBe(true);

    info.mockClear();
    apiFetch.mockResolvedValueOnce(new Response('{"authenticated":true}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(getCurrentUser({ scopeGeneration: 3, activeScopePresent: true }))
      .rejects.toThrow('Current-user response schema was invalid.');
    expect(info.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      phase: 'parsed-user-rejected', classification: 'invalid-schema', schemaAccepted: false,
    }));
  });

  it('preserves the exact hosted-web URL and no-store request contract', async () => {
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(validUser), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));

    await expect(getCurrentUser()).resolves.toEqual(validUser);

    expect(apiFetch).toHaveBeenCalledOnce();
    expect(apiFetch).toHaveBeenCalledWith('https://example.test/api/auth/user', {
      credentials: 'include',
      cache: 'no-store',
    });
  });

  it('uses a bounded desktop generation cache key without fetch cache inputs', async () => {
    apiFetch.mockImplementation(async () => new Response(JSON.stringify(validUser), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));

    await expect(getCurrentUser({ scopeGeneration: 4, activeScopePresent: true })).resolves.toEqual(validUser);
    await expect(getCurrentUser({ scopeGeneration: 5, activeScopePresent: true })).resolves.toEqual(validUser);
    await expect(getCurrentUser({
      scopeGeneration: Number.MAX_SAFE_INTEGER + 1,
      activeScopePresent: true,
    })).resolves.toEqual(validUser);

    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://example.test/api/auth/user?proprDesktopScopeGeneration=4',
      'https://example.test/api/auth/user?proprDesktopScopeGeneration=5',
      'https://example.test/api/auth/user?proprDesktopScopeGeneration=0',
    ]);
    for (const [, init] of apiFetch.mock.calls) {
      expect(init).toEqual({ credentials: 'include' });
      expect(init).not.toHaveProperty('cache');
      const headers = new Headers(init?.headers);
      expect(headers.has('Cache-Control')).toBe(false);
      expect(headers.has('Pragma')).toBe(false);
    }
  });
});

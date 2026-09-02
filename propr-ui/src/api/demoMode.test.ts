import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_MODE_READ_ONLY_CODE, PROPR_API_ORIGIN_PARITY_CASES } from '@propr/shared';
import {
  apiFetch,
  CommittedConfigWriteError,
  getDemoModeStatus,
  getCurrentUser,
  handleApiResponse,
  handleDesktopAccessCode,
  INSTANCE_AUTHORIZATION_CHANGED_EVENT,
  API_BASE_URL,
  setApiBaseUrl,
  setDesktopConnectionScope,
  TokenRefreshRetryRequiredError,
} from './proprApi';

describe('demo mode API helpers', () => {
  afterEach(() => {
    setDesktopConnectionScope(null);
    setApiBaseUrl('');
    vi.restoreAllMocks();
  });

  it('applies the shared canonical origin parity table to REST and Socket.IO client configuration', () => {
    for (const [name, input, expected] of PROPR_API_ORIGIN_PARITY_CASES) {
      if (expected === null) expect(() => setApiBaseUrl(input), name).toThrow();
      else {
        setApiBaseUrl(input);
        expect(API_BASE_URL, name).toBe(expected);
      }
    }
  });

  it('discovers demo mode from the backend metadata endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ demoMode: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(getDemoModeStatus()).resolves.toEqual({ demoMode: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/demo-mode', { credentials: 'include' });
  });

  it('sends mutating API calls so the backend can reject demo writes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 405 }));

    await expect(apiFetch('/api/planner/generate', { method: 'POST' })).resolves.toMatchObject({
      status: 405,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries once when the backend reports a refreshed GitHub token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'TOKEN_REFRESHED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ repos: ['integry/propr'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const response = await apiFetch('/api/github/repos', { credentials: 'include' });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/github/repos', { credentials: 'include' });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/github/repos', { credentials: 'include' });
  });

  it('does not automatically replay JSON writes after a token refresh response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'TOKEN_REFRESHED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }));
    const request = {
      method: 'POST',
      body: JSON.stringify({ repository: 'integry/propr' }),
    };

    const response = await apiFetch('/api/tasks/import', request);

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/tasks/import', request);
  });

  it('replays a JSON write only when the route contract is explicitly opted in', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'TOKEN_REFRESHED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    const request = {
      method: 'POST',
      body: JSON.stringify({ repository: 'integry/propr' }),
    };

    const response = await apiFetch('/api/tasks/import', request, {
      replayMutationAfterTokenRefresh: true,
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not replay profile A work with profile B after a same-origin scope switch', async () => {
    let parsingStarted!: () => void;
    let releaseParsing!: () => void;
    const started = new Promise<void>(resolve => { parsingStarted = resolve; });
    const released = new Promise<void>(resolve => { releaseParsing = resolve; });
    const refreshed = new Response(JSON.stringify({ code: 'TOKEN_REFRESHED' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
    vi.spyOn(refreshed, 'clone').mockReturnValue({
      json: async () => {
        parsingStarted();
        await released;
        return { code: 'TOKEN_REFRESHED' };
      },
    } as Response);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(refreshed);
    setDesktopConnectionScope({
      bridge: {} as never,
      profileId: 'profile-a',
      transportScope: 'AAAAAAAAAAAAAAAAAAAAAA',
    });

    const pending = apiFetch('/api/tasks');
    await started;
    setDesktopConnectionScope({
      bridge: {} as never,
      profileId: 'profile-b',
      transportScope: 'BBBBBBBBBBBBBBBBBBBBBB',
    });
    releaseParsing();

    await expect(pending).resolves.toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('surfaces an unreplayed token refresh as retry-required without logging out', async () => {
    const response = new Response(JSON.stringify({
      code: 'TOKEN_REFRESHED',
      message: 'Token refreshed; retry this upload.',
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(handleApiResponse(response)).rejects.toMatchObject({
      code: 'TOKEN_REFRESHED',
      message: 'Token refreshed; retry this upload.',
      name: TokenRefreshRetryRequiredError.name,
    });
  });

  it('retries replayable Request instances after a token refresh response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 'TOKEN_REFRESHED',
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ repos: ['integry/propr'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const request = new Request(new URL('/api/github/repos', window.location.origin));
    const response = await apiFetch(request);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, request, undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, request, undefined);
  });

  it('preserves Request and init headers plus the captured scope on retry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'TOKEN_REFRESHED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    setDesktopConnectionScope({
      bridge: {} as never,
      profileId: 'profile-a',
      transportScope: 'SSSSSSSSSSSSSSSSSSSSSS',
    });
    const request = new Request(new URL('/api/tasks', window.location.origin), {
      headers: { 'X-From-Request': 'request', Authorization: 'Bearer renderer' },
    });

    await apiFetch(request, {
      credentials: 'include',
      headers: { 'X-From-Init': 'init', Cookie: 'renderer=session' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchMock.mock.calls) {
      expect(input).toBe(request);
      const headers = new Headers(init?.headers);
      expect(headers.get('X-From-Request')).toBe('request');
      expect(headers.get('X-From-Init')).toBe('init');
      expect(headers.get('X-ProPR-Desktop-Transport-Scope')).toBe('SSSSSSSSSSSSSSSSSSSSSS');
      expect(headers.get('Authorization')).toBe('Bearer renderer');
      expect(headers.get('Cookie')).toBe('renderer=session');
    }
  });

  it('does not retry GitHub re-authentication failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      code: 'GITHUB_REAUTH_REQUIRED',
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }));

    await apiFetch('/api/auth/user', { credentials: 'include' });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sends scoped current-user GETs without browser cache-control inputs', async () => {
    setApiBaseUrl('https://example.test');
    setDesktopConnectionScope({
      bridge: {} as never,
      profileId: 'profile-a',
      transportScope: 'SSSSSSSSSSSSSSSSSSSSSS',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'user-1',
      login: 'operator',
      username: 'operator',
      displayName: 'Operations',
      email: null,
      avatarUrl: null,
      role: 'admin',
      permissions: ['instance.manage_settings'],
      authorizationSource: 'local',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await getCurrentUser({ scopeGeneration: 7, activeScopePresent: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe('https://example.test/api/auth/user?proprDesktopScopeGeneration=7');
    expect(init?.cache).toBeUndefined();
    const headers = new Headers(init?.headers);
    expect(headers.get('X-ProPR-Desktop-Transport-Scope')).toBe('SSSSSSSSSSSSSSSSSSSSSS');
    expect(headers.has('Cache-Control')).toBe(false);
    expect(headers.has('Pragma')).toBe(false);
  });

  it('converts demo read-only 405 responses into a clear error', async () => {
    const response = new Response(JSON.stringify({
      code: DEMO_MODE_READ_ONLY_CODE,
      error: 'Demo mode is read-only. Changes are not allowed.',
    }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(handleApiResponse(response)).rejects.toMatchObject({
      code: DEMO_MODE_READ_ONLY_CODE,
      message: 'Demo mode is read-only. Changes are not allowed.',
    });
  });

  it('requests a current-user refresh after a stale permission is rejected', async () => {
    const listener = vi.fn();
    window.addEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, listener);
    const response = new Response(JSON.stringify({
      code: 'INSUFFICIENT_INSTANCE_PERMISSION',
      error: 'Forbidden',
      message: 'This action requires the instance.manage_settings permission.',
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(handleApiResponse(response)).rejects.toThrow(
      'This action requires the instance.manage_settings permission.'
    );

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, listener);
  });

  it('does not dispatch a stale authorization change after the desktop profile generation switches', async () => {
    const listener = vi.fn();
    const scopeA = {
      bridge: { connection: { invalidate: vi.fn() } } as never,
      profileId: 'profile-a',
      transportScope: 'DDDDDDDDDDDDDDDDDDDDDD',
    };
    const scopeB = {
      bridge: { connection: { invalidate: vi.fn() } } as never,
      profileId: 'profile-b',
      transportScope: 'EEEEEEEEEEEEEEEEEEEEEE',
    };
    setDesktopConnectionScope(scopeA);
    window.addEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, listener);
    const response = new Response(JSON.stringify({
      code: 'INSUFFICIENT_INSTANCE_PERMISSION',
      message: 'Forbidden',
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    const scopedResponse = await apiFetch('/api/tasks');
    setDesktopConnectionScope(scopeB);
    await expect(handleApiResponse(scopedResponse)).rejects.toThrow('Forbidden');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, listener);
  });

  it('preserves desktop credentials for authorization changes and transient authentication failures', async () => {
    const invalidate = vi.fn(async () => ({ invalidated: false }));
    const scope = {
      bridge: { connection: { invalidate } } as never,
      profileId: 'profile-a',
      transportScope: 'IIIIIIIIIIIIIIIIIIIIII',
    };
    const listener = vi.fn();
    window.addEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, listener);
    setDesktopConnectionScope(scope);

    await expect(handleDesktopAccessCode('AUTHORIZATION_CHANGED', scope)).resolves.toBe('authorization-changed');
    await expect(handleDesktopAccessCode('AUTHENTICATION_FAILED', scope)).resolves.toBe('retryable');

    expect(listener).toHaveBeenCalledOnce();
    expect(invalidate).not.toHaveBeenCalled();
    window.removeEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, listener);
  });

  it.each([
    { status: 409, lockLostAfterCommit: true },
    { status: 500, lockLostAfterCommit: false },
  ])('preserves committed configuration metadata for HTTP $status responses', async ({ status, lockLostAfterCommit }) => {
    const response = new Response(JSON.stringify({
      success: status === 409,
      committed: true,
      error: status === 500 ? 'Notification publication failed after saving.' : undefined,
      warning: status === 409 ? 'The lock was lost after saving.' : undefined,
      lock_lost_after_commit: lockLostAfterCommit,
    }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

    const error = await handleApiResponse(response).catch(caught => caught);

    expect(error).toBeInstanceOf(CommittedConfigWriteError);
    expect(error).toMatchObject({
      committed: true,
      status,
      lockLostAfterCommit,
      responseBody: { committed: true },
    });
  });

  it('surfaces explicitly allowlisted public messages for server errors', async () => {
    const response = new Response(JSON.stringify({
      code: 'AGENT_VERSION_LOOKUP_UNAVAILABLE',
      error: "Failed to resolve version for agent 'codex': Agent version lookup is temporarily unavailable",
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(handleApiResponse(response)).rejects.toThrow(
      "Failed to resolve version for agent 'codex': Agent version lookup is temporarily unavailable"
    );
  });

  it('continues to hide unclassified server error bodies', async () => {
    const response = new Response(JSON.stringify({
      error: 'Internal database details must not be displayed',
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(handleApiResponse(response)).rejects.toThrow(
      'The server ran into a problem (HTTP 502). Please try again in a moment.'
    );
  });

  it('continues to allow GET requests in demo mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await apiFetch('/api/tasks', { credentials: 'include' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

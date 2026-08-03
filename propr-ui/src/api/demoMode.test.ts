import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_MODE_READ_ONLY_CODE } from '@propr/shared';
import {
  apiFetch,
  CommittedConfigWriteError,
  getDemoModeStatus,
  handleApiResponse,
  INSTANCE_AUTHORIZATION_CHANGED_EVENT,
  TokenRefreshRetryRequiredError,
} from './proprApi';

describe('demo mode API helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it('retries replayable JSON writes after a token refresh response', async () => {
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

    const response = await apiFetch('/api/tasks/import', request);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/tasks/import', request);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/tasks/import', request);
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

    const request = new Request('http://localhost/api/github/repos');
    const response = await apiFetch(request);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, request, undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, request, undefined);
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

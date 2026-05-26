import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, getDemoModeStatus, setDemoModeEnabled } from './proprApi';

describe('demo mode API helpers', () => {
  afterEach(() => {
    setDemoModeEnabled(false);
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

  it('blocks mutating API calls locally after demo mode is detected', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    setDemoModeEnabled(true);

    await expect(apiFetch('/api/planner/generate', { method: 'POST' })).rejects.toMatchObject({
      code: 'DEMO_MODE_READ_ONLY',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('continues to allow GET requests in demo mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    setDemoModeEnabled(true);

    await apiFetch('/api/tasks', { credentials: 'include' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

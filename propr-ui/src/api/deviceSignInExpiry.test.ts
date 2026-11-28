import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleApiResponse } from './apiClient';
import { navigateToUiPath } from '../config/runtimeMode';

vi.mock('../config/runtimeMode', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/runtimeMode')>(),
  currentUiPathname: () => '/',
  isDesktopRuntime: () => false,
  navigateToUiPath: vi.fn(),
}));

const unauthorized = (body: Record<string, unknown>) => new Response(JSON.stringify(body), {
  status: 401,
  headers: { 'Content-Type': 'application/json' },
});

describe('an expired device sign-in', () => {
  afterEach(() => { vi.mocked(navigateToUiPath).mockReset(); });

  it('sends the browser to the login page with the device-expired message', async () => {
    await expect(handleApiResponse(unauthorized({
      code: 'GITHUB_REAUTH_REQUIRED',
      reason: 'device_sign_in_expired',
      message: 'Your GitHub sign-in expired. Sign in again with a new code.',
    }))).rejects.toThrow('Authentication required');
    expect(navigateToUiPath).toHaveBeenCalledWith('/login?error=device_sign_in_expired');
  });

  it('keeps the plain login redirect for other expired sessions', async () => {
    await expect(handleApiResponse(unauthorized({ code: 'GITHUB_REAUTH_REQUIRED' }))).rejects.toThrow('Authentication required');
    await expect(handleApiResponse(unauthorized({ error: 'Unauthorized', reason: 'device_sign_in_expired' }))).rejects.toThrow('Authentication required');
    expect(vi.mocked(navigateToUiPath).mock.calls).toEqual([['/login'], ['/login']]);
  });
});

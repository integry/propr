import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_TRANSPORT_SCOPE_HEADER } from '@propr/shared';
import { setApiBaseUrl, setDesktopConnectionScope } from '../api/apiClient';
import { PACKAGED_ACCEPTANCE_CURRENT_USER_PREFIX } from '../desktop/packagedAcceptanceCurrentUserValidation';
import { useCurrentUserBootstrap } from './useCurrentUserBootstrap';

vi.mock('../config/runtimeMode', () => ({
  currentUiPathname: () => '/',
  isDesktopRuntime: () => true,
}));

type AcceptanceWindow = Window & { __PROPR_PACKAGED_ACCEPTANCE__?: unknown };

const scope = 'SSSSSSSSSSSSSSSSSSSSSS';
const user = {
  id: 'acceptance-user',
  login: 'acceptance-admin',
  username: 'acceptance-admin',
  displayName: 'Acceptance Admin',
  email: null,
  avatarUrl: null,
  role: 'admin' as const,
  permissions: ['instance.manage_settings' as const],
  authorizationSource: 'local' as const,
};

describe('desktop current-user bootstrap main-proxy integration', () => {
  afterEach(() => {
    cleanup();
    setDesktopConnectionScope(null);
    setApiBaseUrl('');
    delete (window as AcceptanceWindow).__PROPR_PACKAGED_ACCEPTANCE__;
    vi.restoreAllMocks();
  });

  it('correlates one fixed-alias React bootstrap request through apiFetch and main-only bearer custody', async () => {
    (window as AcceptanceWindow).__PROPR_PACKAGED_ACCEPTANCE__ = {};
    setDesktopConnectionScope({
      bridge: {} as never,
      profileId: 'profile-a',
      transportScope: scope,
    }, 'http://127.0.0.2:41731');

    const mainProxyRecords: Array<Record<string, unknown>> = [];
    const upstreamRecords: Array<Record<string, unknown>> = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input.toString());
      const rendererHeaders = new Headers(init?.headers);
      const generation = url.searchParams.get('proprDesktopScopeGeneration');
      const mainAccepted = (init?.method ?? 'GET') === 'GET'
        && url.pathname === '/api/auth/user'
        && generation === '1'
        && [...url.searchParams].length === 1
        && rendererHeaders.get(DESKTOP_TRANSPORT_SCOPE_HEADER) === scope
        && !rendererHeaders.has('Authorization')
        && !rendererHeaders.has('Cookie');
      mainProxyRecords.push({ generation, mainAccepted, rendererBearerPresent: false, rendererCookiePresent: false });
      if (!mainAccepted) return new Response(null, { status: 401 });

      const outboundHeaders = new Headers(rendererHeaders);
      outboundHeaders.delete(DESKTOP_TRANSPORT_SCOPE_HEADER);
      outboundHeaders.set('Authorization', 'Bearer main-injected');
      upstreamRecords.push({
        generation,
        authorization: outboundHeaders.get('Authorization'),
        cookiePresent: outboundHeaders.has('Cookie'),
      });
      return new Response(JSON.stringify(user), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const { result } = renderHook(() => useCurrentUserBootstrap({
      isDemoMode: false,
      isDemoModeLoading: false,
    }));

    await waitFor(() => expect(result.current.currentUser).toEqual(user));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mainProxyRecords).toEqual([{
      generation: '1', mainAccepted: true, rendererBearerPresent: false, rendererCookiePresent: false,
    }]);
    expect(upstreamRecords).toEqual([{
      generation: '1', authorization: 'Bearer main-injected', cookiePresent: false,
    }]);
    expect(info.mock.calls.filter(call => call[0] === PACKAGED_ACCEPTANCE_CURRENT_USER_PREFIX)
      .map(call => call[1])).toEqual([
      expect.objectContaining({ phase: 'request-issued', scopeGeneration: 1, activeScopePresent: true }),
      expect.objectContaining({ phase: 'response-completed', scopeGeneration: 1, responseStatus: 200 }),
      expect.objectContaining({ phase: 'parsed-user-accepted', scopeGeneration: 1, schemaAccepted: true }),
      expect.objectContaining({ phase: 'active-scope-accepted', scopeGeneration: 1, schemaAccepted: true }),
    ]);
  });
});

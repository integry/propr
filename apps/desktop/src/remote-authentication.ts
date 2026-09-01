import type { DesktopRemoteAuthenticationRequest } from './shared/contract';
import { normalizeApiBaseUrl } from './security';

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export const remoteAuthenticationUrl = (request: DesktopRemoteAuthenticationRequest): string => {
  if (!request || typeof request !== 'object' || !PROFILE_ID_PATTERN.test(request.profileId)) {
    throw new Error('Invalid remote authentication request');
  }
  const apiBaseUrl = normalizeApiBaseUrl(request.apiBaseUrl);
  if (!apiBaseUrl || apiBaseUrl !== request.apiBaseUrl || !apiBaseUrl.startsWith('https://')) {
    throw new Error('Remote authentication requires an exact canonical HTTPS instance origin');
  }

  const recovery = new URL('propr://connect');
  recovery.searchParams.set('api', apiBaseUrl);
  const endpoint = new URL('/api/auth/github', apiBaseUrl);
  endpoint.searchParams.set('redirect_to', recovery.href);

  if (
    endpoint.origin !== apiBaseUrl
    || endpoint.pathname !== '/api/auth/github'
    || endpoint.hash
    || [...endpoint.searchParams.keys()].join(',') !== 'redirect_to'
  ) {
    throw new Error('Remote authentication endpoint is invalid');
  }
  return endpoint.href;
};

export const openRemoteAuthentication = async (
  request: DesktopRemoteAuthenticationRequest,
  openExternal: (url: string) => Promise<unknown>,
): Promise<void> => {
  await openExternal(remoteAuthenticationUrl(request));
};

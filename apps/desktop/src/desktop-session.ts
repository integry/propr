import type { Session } from 'electron';
import { normalizeApiBaseUrl } from './security';

export const logoutDesktopSession = async (
  desktopSession: Pick<Session, 'fetch'>,
  apiBaseUrl: unknown,
): Promise<void> => {
  if (typeof apiBaseUrl !== 'string') throw new Error('Invalid desktop API URL');
  const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  if (!normalizedApiBaseUrl || normalizedApiBaseUrl !== apiBaseUrl) throw new Error('Invalid desktop API URL');
  const response = await desktopSession.fetch(`${normalizedApiBaseUrl}/api/auth/logout`, {
    credentials: 'include',
    redirect: 'manual',
  });
  if (!response.ok && (response.status < 300 || response.status >= 400)) {
    throw new Error(`Desktop logout failed with HTTP ${response.status}`);
  }
};

/** Remove legacy/browser cookies so named bearer profiles cannot inherit them. */
export const clearDesktopInstanceCookies = async (
  desktopSession: Pick<Session, 'clearStorageData'>,
  apiBaseUrls: readonly unknown[],
): Promise<void> => {
  const origins = new Set<string>();
  for (const value of apiBaseUrls) {
    if (typeof value !== 'string') throw new Error('Invalid desktop API URL');
    const normalized = normalizeApiBaseUrl(value);
    if (!normalized || normalized !== value) throw new Error('Invalid desktop API URL');
    origins.add(normalized);
  }
  await Promise.all([...origins].map(origin => desktopSession.clearStorageData({
    origin,
    storages: ['cookies'],
  })));
};

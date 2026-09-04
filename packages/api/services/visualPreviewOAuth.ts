import {
  VisualPreviewOAuthCredentialService,
  isSupportedVisualPreviewUploadToken,
  type VisualPreviewOAuthCredentialInput,
} from '@propr/core';
import type { GitHubUser } from '../authTypes.js';
import { resolveInstanceAuthorization } from '../authorization.js';
import { isUserWhitelisted } from '../userWhitelist.js';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export const visualPreviewOAuthCredentialService = new VisualPreviewOAuthCredentialService();

export function visualPreviewCredentialFromUser(user: GitHubUser): VisualPreviewOAuthCredentialInput | null {
  const accessToken = user.accessToken?.trim();
  if (!accessToken || !isSupportedVisualPreviewUploadToken(accessToken)) return null;
  return {
    githubUserId: user.id,
    githubUsername: user.username,
    source: user.oauthSource || 'github',
    accessToken,
    refreshToken: user.refreshToken,
    accessTokenExpiresAt: user.tokenExpiresAt,
    refreshTokenExpiresAt: user.refreshTokenExpiresAt,
  };
}

export async function captureVisualPreviewCredentialFromAdminLogin(user: GitHubUser): Promise<boolean> {
  if (!isUserWhitelisted(user.username)) return false;
  const credential = visualPreviewCredentialFromUser(user);
  if (!credential) return false;
  const authorization = await resolveInstanceAuthorization(user);
  if (authorization.role !== 'admin') return false;
  return visualPreviewOAuthCredentialService.captureFromLogin(credential);
}

export async function updateVisualPreviewCredentialForCurrentOwner(user: GitHubUser): Promise<boolean> {
  const credential = visualPreviewCredentialFromUser(user);
  if (!credential) return false;
  return visualPreviewOAuthCredentialService.updateIfOwner(credential);
}

export interface VisualPreviewOAuthRefreshScheduler {
  close: () => Promise<void>;
}

export async function startVisualPreviewOAuthRefreshScheduler(
  service = visualPreviewOAuthCredentialService,
): Promise<VisualPreviewOAuthRefreshScheduler> {
  let closed = false;
  let activeRefresh: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (activeRefresh) return activeRefresh;
    activeRefresh = service.refreshIfNeeded()
      .then(result => {
        if (result === 'refreshed') console.log('[visual-preview] Refreshed the GitHub OAuth upload credential');
        if (result === 'reauth-required') console.warn('[visual-preview] GitHub OAuth upload credential requires reconnection');
      })
      .catch(error => {
        console.warn('[visual-preview] Could not refresh the GitHub OAuth upload credential:', (error as Error).message);
      })
      .finally(() => { activeRefresh = undefined; });
    return activeRefresh;
  };

  await refresh();
  const timer = setInterval(() => { if (!closed) void refresh(); }, REFRESH_INTERVAL_MS);
  timer.unref();
  return {
    close: async () => {
      closed = true;
      clearInterval(timer);
      await activeRefresh;
    },
  };
}

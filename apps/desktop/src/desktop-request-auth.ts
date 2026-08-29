import type { Session } from 'electron';
import type { ProfileStore } from './profile-store';
import { isTrustedRendererUrl } from './security';

interface RequestDetails {
  url: string;
  initiator?: string;
  webContentsId?: number;
  requestHeaders: Record<string, string>;
}

export async function authenticatedDesktopRequestHeaders(
  details: RequestDetails,
  options: {
    profiles: ProfileStore;
    devServerUrl?: string;
    packagedRendererUrl: string;
    rendererWebContentsId?: number;
  },
): Promise<Record<string, string>> {
  const trustedInitiator = details.initiator
    ? isTrustedRendererUrl(details.initiator, options.devServerUrl, options.packagedRendererUrl)
    : false;
  if (!trustedInitiator && details.webContentsId !== options.rendererWebContentsId) return details.requestHeaders;

  const state = await options.profiles.list();
  const active = state.profiles.find(profile => profile.id === state.activeProfileId);
  if (!active) return details.requestHeaders;
  let target: URL;
  try { target = new URL(details.url); } catch { return details.requestHeaders; }
  if (target.origin !== active.apiBaseUrl) return details.requestHeaders;
  if (Object.keys(details.requestHeaders).some(header => header.toLowerCase() === 'authorization')) {
    return details.requestHeaders;
  }
  const credential = await options.profiles.readCredential(active.id);
  if (!credential.available || !credential.value || /\r|\n/.test(credential.value)) return details.requestHeaders;
  return { ...details.requestHeaders, Authorization: `Bearer ${credential.value}` };
}

/** Install main-process bearer injection for the active profile's exact origin. */
export function configureDesktopRequestAuthentication(
  desktopSession: Session,
  options: {
    profiles: ProfileStore;
    devServerUrl?: string;
    packagedRendererUrl: string;
    rendererWebContentsId(): number | undefined;
  },
): void {
  desktopSession.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      void authenticatedDesktopRequestHeaders(details, {
        ...options,
        rendererWebContentsId: options.rendererWebContentsId(),
      }).then(
        requestHeaders => callback({ requestHeaders }),
        () => callback({ requestHeaders: details.requestHeaders }),
      );
    },
  );
}

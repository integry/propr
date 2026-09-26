import { useEffect, useState, useSyncExternalStore } from 'react';
import { trustedApplicationPreviewMediaUrl } from '@propr/shared';
import { useCurrentUser } from '../contexts/AuthContext';
import {
  apiFetch,
  getDesktopSocketConfigurationKey,
  handleApiResponse,
  subscribeDesktopConnectionScope,
} from '../api/apiClient';

type PreviewMediaSource =
  | { status: 'loading'; src: null }
  | { status: 'ready'; src: string }
  | { status: 'failed'; src: null };

/**
 * Loads application-served previews through the shared authenticated client.
 * Blob URLs are scoped to the active browser account/Desktop profile and are
 * revoked before an account or connection can reuse them.
 */
export function usePreviewMediaSource(url: string): PreviewMediaSource {
  const currentUser = useCurrentUser();
  const connectionKey = useSyncExternalStore(
    subscribeDesktopConnectionScope,
    getDesktopSocketConfigurationKey,
    getDesktopSocketConfigurationKey,
  );
  const scopeKey = `${connectionKey}\0${currentUser?.id ?? 'anonymous'}\0${url}`;
  const protectedUrl = trustedApplicationPreviewMediaUrl(url);
  const [loaded, setLoaded] = useState<{ scopeKey: string; value: PreviewMediaSource }>(() => ({
    scopeKey,
    value: !url ? { status: 'failed', src: null }
      : protectedUrl ? { status: 'loading', src: null } : { status: 'ready', src: url },
  }));

  useEffect(() => {
    if (!url) {
      setLoaded({ scopeKey, value: { status: 'failed', src: null } });
      return;
    }
    if (!protectedUrl) {
      setLoaded({ scopeKey, value: { status: 'ready', src: url } });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let disposed = false;
    setLoaded({ scopeKey, value: { status: 'loading', src: null } });
    void apiFetch(protectedUrl, { credentials: 'include', signal: controller.signal })
      .then(handleApiResponse)
      .then(response => response.blob())
      .then(blob => {
        if (disposed || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ scopeKey, value: { status: 'ready', src: objectUrl } });
      })
      .catch(() => {
        if (!disposed && !controller.signal.aborted) {
          setLoaded({ scopeKey, value: { status: 'failed', src: null } });
        }
      });
    return () => {
      disposed = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [protectedUrl, scopeKey, url]);

  if (loaded.scopeKey !== scopeKey) {
    return protectedUrl ? { status: 'loading', src: null }
      : url ? { status: 'ready', src: url } : { status: 'failed', src: null };
  }
  return loaded.value;
}

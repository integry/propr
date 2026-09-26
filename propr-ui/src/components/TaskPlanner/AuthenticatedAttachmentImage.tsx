import React, { useEffect, useState, useSyncExternalStore } from 'react';
import {
  apiFetch,
  getDesktopConnectionScope,
  handleApiResponse,
  subscribeDesktopConnectionScope,
} from '../../api/apiClient';

interface AuthenticatedAttachmentImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src: string;
}

export const AuthenticatedAttachmentImage: React.FC<AuthenticatedAttachmentImageProps> = ({ src, ...props }) => {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const desktopScopeKey = useSyncExternalStore(
    subscribeDesktopConnectionScope,
    () => {
      const scope = getDesktopConnectionScope();
      return `${scope?.profileId ?? ''}\u0000${scope?.transportScope ?? ''}`;
    },
    () => '',
  );

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let loadedObjectUrl: string | null = null;
    setObjectUrl(null);
    const release = (): void => {
      controller.abort();
      if (loadedObjectUrl) {
        URL.revokeObjectURL(loadedObjectUrl);
        loadedObjectUrl = null;
      }
      if (!disposed) setObjectUrl(null);
    };
    void apiFetch(src, { credentials: 'include', signal: controller.signal })
      .then(handleApiResponse)
      .then(response => response.blob())
      .then(blob => {
        if (disposed || controller.signal.aborted) return;
        loadedObjectUrl = URL.createObjectURL(blob);
        setObjectUrl(loadedObjectUrl);
      })
      .catch(() => {
        if (!disposed && !controller.signal.aborted) setObjectUrl(null);
      });

    return () => {
      release();
      disposed = true;
    };
  }, [src, desktopScopeKey]);

  return objectUrl ? <img {...props} src={objectUrl} /> : null;
};

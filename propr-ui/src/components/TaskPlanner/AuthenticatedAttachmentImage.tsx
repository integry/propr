import React, { useEffect, useState } from 'react';
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

  useEffect(() => {
    const controller = new AbortController();
    const capturedScope = getDesktopConnectionScope()?.transportScope ?? null;
    let disposed = false;
    let loadedObjectUrl: string | null = null;
    const release = (): void => {
      controller.abort();
      if (loadedObjectUrl) {
        URL.revokeObjectURL(loadedObjectUrl);
        loadedObjectUrl = null;
      }
      if (!disposed) setObjectUrl(null);
    };
    const unsubscribe = subscribeDesktopConnectionScope(() => {
      if ((getDesktopConnectionScope()?.transportScope ?? null) !== capturedScope) release();
    });

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
      disposed = true;
      unsubscribe();
      release();
    };
  }, [src]);

  return objectUrl ? <img {...props} src={objectUrl} /> : null;
};

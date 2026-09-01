import { useEffect, useRef } from 'react';
import type { DesktopAccessInvalidEventDetail, DesktopConnectionResult } from './types';
import { DESKTOP_ACCESS_INVALID_EVENT } from './types';

export const matchesDesktopAccessInvalidation = (
  profileId: string,
  result: Extract<DesktopConnectionResult, { status: 'ready' }>,
  detail: DesktopAccessInvalidEventDetail | undefined,
): detail is DesktopAccessInvalidEventDetail => Boolean(
  detail && detail.profileId === profileId && detail.transportScope === result.transportScope,
);

export const revokedDesktopConnection = (
  result: Extract<DesktopConnectionResult, { status: 'ready' }>,
): Exclude<DesktopConnectionResult, { status: 'ready' }> => ({
  status: 'authentication-required',
  message: 'Access to this instance was revoked or expired. Pair again to continue.',
  version: result.version,
  authentication: result.authentication,
});

export const useDesktopAccessInvalidation = (
  listener: (detail: DesktopAccessInvalidEventDetail | undefined) => void,
): void => {
  const current = useRef(listener);
  current.current = listener;
  useEffect(() => {
    const receive = (event: Event) => current.current(
      (event as CustomEvent<DesktopAccessInvalidEventDetail>).detail,
    );
    window.addEventListener(DESKTOP_ACCESS_INVALID_EVENT, receive);
    return () => window.removeEventListener(DESKTOP_ACCESS_INVALID_EVENT, receive);
  }, []);
};

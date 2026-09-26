import { useCallback, useRef } from 'react';
import type { DesktopProfile } from './types';

/** Fences Connect consumption until the matching confirmation editor commits. */
export const useConnectCandidatePresentation = () => {
  const pending = useRef<{
    profile: DesktopProfile;
    resolve(visible: boolean): void;
  } | null>(null);
  const waitForPresentation = useCallback((profile: DesktopProfile): Promise<boolean> => {
    pending.current?.resolve(false);
    return new Promise(resolve => { pending.current = { profile, resolve }; });
  }, []);
  const recordPresentation = useCallback((profile: DesktopProfile): void => {
    const current = pending.current;
    if (!current || current.profile.id !== profile.id
      || current.profile.baseUrl !== profile.baseUrl) return;
    pending.current = null;
    current.resolve(true);
  }, []);
  return { recordPresentation, waitForPresentation };
};

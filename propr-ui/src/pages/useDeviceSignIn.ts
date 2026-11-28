import { useEffect, useState } from 'react';
import { getSignInMethod, type SignInMethod } from '../api/deviceSignInApi';
import { isHostedUiOrigin } from '../config/runtimeConfig';

/**
 * Whether the login page should run GitHub device sign-in in place. Packaged
 * desktop and the hosted UI have their own sign-in, so only a browser on the
 * instance's own origin asks the API which method it uses.
 */
export const useDeviceSignIn = (options: { desktop: boolean; isDemoMode: boolean; isDemoModeLoading: boolean }): boolean => {
  const { desktop, isDemoMode, isDemoModeLoading } = options;
  const [signInMethod, setSignInMethod] = useState<SignInMethod | null>(null);
  const eligible = !desktop && !isDemoMode && !isHostedUiOrigin(window.location.hostname);

  useEffect(() => {
    if (!eligible || isDemoModeLoading) return;
    let cancelled = false;
    void getSignInMethod().then(method => {
      if (!cancelled) setSignInMethod(method);
    });
    return () => { cancelled = true; };
  }, [eligible, isDemoModeLoading]);

  return eligible && signInMethod === 'device';
};

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useDemoMode } from '../contexts/DemoModeContext';
import { getCurrentUser } from '../api/proprApi';
import {
  getApiBaseUrl,
  isHostedUiOrigin,
  pathWithActiveHostedTunnelFlow,
} from '../config/runtimeConfig';
import { isProprProxyUrl } from '@propr/shared';
import { useDesktop } from '../desktop/DesktopContext';
import { useRefreshCurrentUser } from '../contexts/AuthContext';

// For OAuth, use main API to avoid registering multiple callback URLs
// Falls back to API_BASE_URL for main site
const getOAuthApiUrl = (): string => import.meta.env.VITE_OAUTH_API_URL || getApiBaseUrl();
const HOSTED_OAUTH_COMPLETION_PATH = '/login?oauth_complete=true';
const HOSTED_OAUTH_POLL_INTERVAL_MS = 1_000;
const HOSTED_OAUTH_POPUP_CHECK_INTERVAL_MS = 500;
const HOSTED_OAUTH_TIMEOUT_MS = 5 * 60 * 1_000;

interface BuildGithubOAuthUrlOptions {
  hostedPopupCompletion?: boolean;
  activeApiBaseUrl?: string;
}

interface HostedOAuthFlow {
  id: number;
  popup: Window;
  pollIntervalId: number;
  popupCheckIntervalId: number;
  timeoutId: number;
  closeCheckStarted: boolean;
}

interface DemoEntryWindow {
  location: Pick<Location, 'hostname' | 'href'>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const navigateToDemoEntry = (targetWindow: DemoEntryWindow = window): void => {
  targetWindow.location.href = pathWithActiveHostedTunnelFlow('/', targetWindow.location.hostname);
};

// Only same-origin, absolute in-app paths are safe redirect targets. This
// rejects external URLs ("https://evil.example/path"), protocol-relative URLs
// ("//evil.example/path"), backslash tricks and control characters that can make
// browser redirect handling ambiguous.
const isSafeInternalPath = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//') || value.startsWith('/\\')) return false;
  if (/[\u0000-\u001F\u007F\\]/.test(value)) return false;
  return true;
};

const safeInternalPath = (value: unknown, origin: URL): string => {
  if (!isSafeInternalPath(value)) return '/';
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin.origin) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
};

const validatedHttpUrl = (value: string, fallbackBase?: string): URL => {
  const url = new URL(value || fallbackBase || '');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OAuth URL must use http(s).');
  }
  return url;
};

const validateOAuthApiBaseUrl = (
  oauthApiUrl: string,
  origin: URL,
  hostname: string,
  options: BuildGithubOAuthUrlOptions = {}
): URL => {
  const url = validatedHttpUrl(oauthApiUrl.trim(), origin.origin);
  if (url.username || url.password || /[^/]/.test(url.pathname) || url.search || url.hash) {
    throw new Error('OAuth API URL must be a bare http(s) origin.');
  }
  if (options.hostedPopupCompletion && isHostedUiOrigin(hostname)) {
    const activeApiBaseUrl = (options.activeApiBaseUrl ?? getApiBaseUrl()).trim();
    let activeApiUrl: URL;
    try {
      activeApiUrl = validatedHttpUrl(activeApiBaseUrl);
    } catch {
      throw new Error('Hosted OAuth requires an active managed ProPR tunnel.');
    }
    if (!isProprProxyUrl(activeApiUrl.origin)) {
      throw new Error('Hosted OAuth requires an active managed ProPR tunnel.');
    }
    if (url.origin !== activeApiUrl.origin) {
      throw new Error('Hosted OAuth API URL must match the active ProPR tunnel.');
    }
  }
  return url;
};

// Resolve where to send the user after a successful login, preferring the page
// they came from (router location state), then a `redirect_to` query param, and
// finally the dashboard root. Any unsafe/external target falls back to '/'.
const resolveReturnPath = (state: unknown, redirectToParam: string | null): string => {
  const fromState = (state as { from?: unknown } | null)?.from;
  if (isSafeInternalPath(fromState)) return fromState;
  if (fromState && typeof fromState === 'object') {
    const loc = fromState as { pathname?: unknown; search?: unknown; hash?: unknown };
    if (typeof loc.pathname === 'string') {
      const search = typeof loc.search === 'string' ? loc.search : '';
      const hash = typeof loc.hash === 'string' ? loc.hash : '';
      const candidate = `${loc.pathname}${search}${hash}`;
      if (isSafeInternalPath(candidate)) return candidate;
    }
  }
  if (isSafeInternalPath(redirectToParam)) return redirectToParam;
  return '/';
};

// eslint-disable-next-line react-refresh/only-export-components
export const buildGithubOAuthUrl = (
  returnPath: string,
  origin = window.location.origin,
  oauthApiUrl = getOAuthApiUrl(),
  hostname = window.location.hostname,
  options: BuildGithubOAuthUrlOptions = {}
): string => {
  const originUrl = validatedHttpUrl(origin);
  const oauthUrl = validateOAuthApiBaseUrl(oauthApiUrl, originUrl, hostname, options);
  const safeReturnPath = safeInternalPath(returnPath, originUrl);
  const redirectPath = options.hostedPopupCompletion && isHostedUiOrigin(hostname)
    ? HOSTED_OAUTH_COMPLETION_PATH
    : pathWithActiveHostedTunnelFlow(safeReturnPath, hostname);
  const redirectTo = new URL(redirectPath, originUrl);

  oauthUrl.pathname = '/api/auth/github';
  oauthUrl.search = '';
  oauthUrl.hash = '';
  oauthUrl.searchParams.set('redirect_to', redirectTo.toString());
  return oauthUrl.toString();
};

const LoginFooter: React.FC = () => (
  <footer className="w-full border-t border-gray-100 bg-white/80 px-4 py-3 text-center text-[11px] leading-tight text-gray-400">
    <a
      href="https://propr.dev"
      target="_blank"
      rel="noopener noreferrer"
      className="hover:text-gray-600 hover:underline"
    >
      ProPR
    </a>{' '}
    v{__APP_VERSION__} <span className="mx-1">·</span> © {new Date().getFullYear()} Rinalds Uzkalns
  </footer>
);

const LoginPage: React.FC = () => {
  useDocumentTitle('Login');
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { isDemoMode, isLoading: isDemoModeLoading } = useDemoMode();
  const desktop = useDesktop();
  const refreshCurrentUser = useRefreshCurrentUser();
  const loggedOut = searchParams.get('logged_out') === 'true';
  const isOAuthCompletion = searchParams.get('oauth_complete') === 'true';
  const hostedOAuthFlowRef = useRef<HostedOAuthFlow | null>(null);
  const nextHostedOAuthFlowIdRef = useRef(0);

  const returnPath = useMemo(
    () => resolveReturnPath(location.state, searchParams.get('redirect_to')),
    [location.state, searchParams]
  );
  const returnPathWithActiveFlow = useMemo(() => pathWithActiveHostedTunnelFlow(returnPath), [returnPath]);

  // Start in the "recovering" state (showing a spinner instead of the OAuth
  // button) unless we already know recovery should be skipped. This avoids a
  // flash of the login button before the session check resolves.
  const [isRecovering, setIsRecovering] = useState(!loggedOut && !isOAuthCompletion);
  const [isHostedOAuthPolling, setIsHostedOAuthPolling] = useState(false);
  const [isDesktopAuthenticating, setIsDesktopAuthenticating] = useState(false);
  const [hostedOAuthError, setHostedOAuthError] = useState<string | null>(null);

  const stopHostedOAuthFlow = useCallback((closePopup = false) => {
    const flow = hostedOAuthFlowRef.current;
    if (!flow) return;
    window.clearInterval(flow.pollIntervalId);
    window.clearInterval(flow.popupCheckIntervalId);
    window.clearTimeout(flow.timeoutId);
    if (closePopup) {
      try {
        if (!flow.popup.closed) flow.popup.close();
      } catch { /* cross-origin popup handles can throw while closing */ }
    }
    hostedOAuthFlowRef.current = null;
  }, []);

  const failHostedOAuthFlow = useCallback((flowId: number, message: string, closePopup = false) => {
    if (hostedOAuthFlowRef.current?.id !== flowId) return;
    stopHostedOAuthFlow(closePopup);
    setIsHostedOAuthPolling(false);
    setHostedOAuthError(message);
  }, [stopHostedOAuthFlow]);

  useEffect(() => {
    // Wait until demo-mode status is known before deciding whether to recover.
    if (isDemoModeLoading) return;

    // Skip automatic session recovery in demo mode or right after an explicit
    // logout, since silently logging the user back in would be surprising.
    if (isDemoMode || loggedOut || isOAuthCompletion) {
      setIsRecovering(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        await getCurrentUser();
        if (cancelled) return;
        // The server still has (or could refresh) a valid session, so send
        // the user back to where they came from.
        navigate(returnPathWithActiveFlow, { replace: true });
      } catch {
        // Auth failures, network errors, and invalid responses fall through to
        // the login UI.
        if (!cancelled) setIsRecovering(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isDemoMode, isDemoModeLoading, isOAuthCompletion, loggedOut, navigate, returnPathWithActiveFlow]);

  useEffect(() => () => {
    stopHostedOAuthFlow(true);
  }, [stopHostedOAuthFlow]);

  const startHostedOAuthFlow = useCallback((oauthUrl: string) => {
    stopHostedOAuthFlow(true);
    setHostedOAuthError(null);

    const popup = window.open(
      oauthUrl,
      '_blank',
      'popup,width=520,height=720'
    );
    if (!popup) {
      setIsHostedOAuthPolling(false);
      setHostedOAuthError('GitHub sign-in could not open. Allow popups for this site, then try again.');
      return;
    }

    const flowId = nextHostedOAuthFlowIdRef.current + 1;
    nextHostedOAuthFlowIdRef.current = flowId;
    setIsHostedOAuthPolling(true);

    const completeHostedOAuthFlow = () => {
      if (hostedOAuthFlowRef.current?.id !== flowId) return;
      stopHostedOAuthFlow(true);
      setIsHostedOAuthPolling(false);
      navigate(returnPathWithActiveFlow, { replace: true });
    };

    const pollForSession = async () => {
      if (hostedOAuthFlowRef.current?.id !== flowId) return;
      try {
        await getCurrentUser();
        completeHostedOAuthFlow();
      } catch {
        // Keep polling until the popup succeeds, closes, times out, or unmounts.
      }
    };

    const checkClosedPopupOnce = async () => {
      const flow = hostedOAuthFlowRef.current;
      if (!flow || flow.id !== flowId || flow.closeCheckStarted) return;
      flow.closeCheckStarted = true;
      window.clearInterval(flow.pollIntervalId);
      window.clearInterval(flow.popupCheckIntervalId);

      try {
        await getCurrentUser();
        completeHostedOAuthFlow();
      } catch {
        failHostedOAuthFlow(flowId, 'The GitHub sign-in window was closed before login completed. Try again.');
      }
    };

    const pollIntervalId = window.setInterval(pollForSession, HOSTED_OAUTH_POLL_INTERVAL_MS);
    const popupCheckIntervalId = window.setInterval(() => {
      try {
        if (popup.closed) {
          void checkClosedPopupOnce();
        }
      } catch {
        void checkClosedPopupOnce();
      }
    }, HOSTED_OAUTH_POPUP_CHECK_INTERVAL_MS);
    const timeoutId = window.setTimeout(() => {
      failHostedOAuthFlow(flowId, 'GitHub sign-in timed out. Try again and finish the popup sign-in.', true);
    }, HOSTED_OAUTH_TIMEOUT_MS);

    hostedOAuthFlowRef.current = {
      id: flowId,
      popup,
      pollIntervalId,
      popupCheckIntervalId,
      timeoutId,
      closeCheckStarted: false,
    };
    void pollForSession();
  }, [failHostedOAuthFlow, navigate, returnPathWithActiveFlow, stopHostedOAuthFlow]);

  const handleLogin = useCallback(() => {
    if (desktop) {
      setHostedOAuthError(null);
      setIsDesktopAuthenticating(true);
      void (async () => {
        try {
          await desktop.authenticate();
          await refreshCurrentUser();
          navigate(returnPathWithActiveFlow, { replace: true });
        } catch (error) {
          setIsDesktopAuthenticating(false);
          setHostedOAuthError(error instanceof Error ? error.message : 'GitHub sign-in did not complete.');
        }
      })();
      return;
    }
    // Local/self-hosted OAuth keeps using redirect_to for the final same-tab
    // navigation back to the page the user came from.
    // Hosted OAuth completes in a popup and the initiating tab polls its own
    // selected tunnel, so the popup receives only an inert same-origin
    // completion URL and no flow authority.
    const hostedLogin = isHostedUiOrigin(window.location.hostname);
    let oauthUrl: string;
    try {
      oauthUrl = buildGithubOAuthUrl(
        returnPath,
        window.location.origin,
        getOAuthApiUrl(),
        window.location.hostname,
        { hostedPopupCompletion: hostedLogin }
      );
    } catch (error) {
      if (hostedLogin) {
        setIsHostedOAuthPolling(false);
        setHostedOAuthError(error instanceof Error ? error.message : 'Hosted GitHub sign-in is not configured correctly.');
        return;
      }
      throw error;
    }
    if (hostedLogin) {
      startHostedOAuthFlow(oauthUrl);
      return;
    }
    window.location.href = oauthUrl;
  }, [desktop, navigate, refreshCurrentUser, returnPath, returnPathWithActiveFlow, startHostedOAuthFlow]);

  if (isRecovering) {
    return (
      <div className="min-h-screen bg-light-100 flex flex-col">
        <div className="flex flex-1 items-center justify-center p-4 sm:p-0">
          <div
            className="h-12 w-12 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600"
            role="status"
            aria-label="Checking session"
          />
        </div>
        <LoginFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-light-100 flex flex-col">
      <div className="flex flex-1 items-center justify-center p-4 sm:p-0">
        <div className="bg-white p-8 rounded-lg shadow-md max-w-md w-full text-center">
          <img src="/media/logo-and-name.png" alt="ProPR" className="h-12 w-auto mx-auto mb-4" />

          {loggedOut && (
            <div className="mb-6 p-3 bg-green-50 text-green-700 rounded-md">
              You have been successfully logged out.
            </div>
          )}

          <p className="text-gray-600 mb-6">
            {isOAuthCompletion
              ? 'GitHub sign-in has finished. You can close this window and return to ProPR.'
              : isDemoMode
              ? 'Demo mode is enabled. You can browse ProPR without GitHub OAuth, but all write and AI execution actions are disabled.'
              : 'Sign in with your GitHub account to access the dashboard.'}
          </p>

          {!isOAuthCompletion && (
            <>
              <button
                onClick={isDemoMode ? () => { navigateToDemoEntry(); } : handleLogin}
                disabled={isHostedOAuthPolling || isDesktopAuthenticating}
                className="w-full bg-gray-900 hover:bg-gray-800 disabled:bg-gray-500 text-white font-medium py-3 px-4 rounded-md transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                </svg>
                {isDemoMode
                  ? 'Enter Demo'
                  : isHostedOAuthPolling || isDesktopAuthenticating
                    ? 'Waiting for GitHub...'
                    : 'Sign in with GitHub'}
              </button>
              {hostedOAuthError && (
                <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
                  {hostedOAuthError}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <LoginFooter />
    </div>
  );
};

export default LoginPage;

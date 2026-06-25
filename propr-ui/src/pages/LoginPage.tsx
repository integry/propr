import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useDemoMode } from '../contexts/DemoModeContext';
import { getCurrentUser } from '../api/proprApi';
import { getApiBaseUrl } from '../config/runtimeConfig';

const API_BASE_URL = getApiBaseUrl();
// For OAuth, use main API to avoid registering multiple callback URLs
// Falls back to API_BASE_URL for main site
const OAUTH_API_URL = import.meta.env.VITE_OAUTH_API_URL || API_BASE_URL;

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
  const loggedOut = searchParams.get('logged_out') === 'true';

  const returnPath = useMemo(
    () => resolveReturnPath(location.state, searchParams.get('redirect_to')),
    [location.state, searchParams]
  );

  // Start in the "recovering" state (showing a spinner instead of the OAuth
  // button) unless we already know recovery should be skipped. This avoids a
  // flash of the login button before the session check resolves.
  const [isRecovering, setIsRecovering] = useState(!loggedOut);

  useEffect(() => {
    // Wait until demo-mode status is known before deciding whether to recover.
    if (isDemoModeLoading) return;

    // Skip automatic session recovery in demo mode or right after an explicit
    // logout, since silently logging the user back in would be surprising.
    if (isDemoMode || loggedOut) {
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
        navigate(returnPath, { replace: true });
      } catch {
        // Auth failures, network errors, and invalid responses fall through to
        // the login UI.
        if (!cancelled) setIsRecovering(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isDemoMode, isDemoModeLoading, loggedOut, navigate, returnPath]);

  const handleLogin = () => {
    // Pass redirect_to so the OAuth flow returns the user to the page they came
    // from (falling back to the dashboard root) after authenticating.
    const redirectTo = encodeURIComponent(window.location.origin + returnPath);
    window.location.href = `${OAUTH_API_URL}/api/auth/github?redirect_to=${redirectTo}`;
  };

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
            {isDemoMode
              ? 'Demo mode is enabled. You can browse ProPR without GitHub OAuth, but all write and AI execution actions are disabled.'
              : 'Sign in with your GitHub account to access the dashboard.'}
          </p>

          <button
            onClick={isDemoMode ? () => { window.location.href = '/'; } : handleLogin}
            className="w-full bg-gray-900 hover:bg-gray-800 text-white font-medium py-3 px-4 rounded-md transition-colors flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
            </svg>
            {isDemoMode ? 'Enter Demo' : 'Sign in with GitHub'}
          </button>
        </div>
      </div>
      <LoginFooter />
    </div>
  );
};

export default LoginPage;

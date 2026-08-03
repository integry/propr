import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import { ToastProvider } from './components/ui/Toast'
import { SocketProvider } from './contexts/SocketProvider'
import { useDemoMode } from './contexts/DemoModeContext'
import { DemoModeProvider } from './contexts/DemoModeProvider'
import DemoModeBanner from './components/DemoModeBanner'
import './App.css'
import { getCurrentUser, INSTANCE_AUTHORIZATION_CHANGED_EVENT } from './api/proprApi'
import { checkProprApiCompatibility, ProprCompatibilityCheckError } from './api/compatibility'
import { hostedUiConnectionIssue, isHostedUiOrigin } from './config/runtimeConfig'
import { AuthProvider, useCurrentUser, userHasPermission } from './contexts/AuthContext'
import type { CurrentUser, InstancePermission } from './api/proprTypes'

const AiAgentsPage = lazy(() => import('./pages/AiAgentsPage'))
const AccessManagementPage = lazy(() => import('./pages/AccessManagementPage'))
const Dashboard = lazy(() => import('./components/Dashboard'))
const LlmLogsPage = lazy(() => import('./pages/LlmLogsPage'))
const LoginPage = lazy(() => import('./pages/LoginPage'))
const PlansPage = lazy(() => import('./pages/PlansPage'))
const PlanStudioPage = lazy(() => import('./pages/PlanStudioPage'))
const RepositoriesPage = lazy(() => import('./pages/RepositoriesPage'))
const RevertPage = lazy(() => import('./pages/RevertPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const SummaryBrowserPage = lazy(() => import('./pages/SummaryBrowserPage'))
const TasksPage = lazy(() => import('./pages/TasksPage'))

type CompatibilityState =
  | { status: 'checking' }
  | { status: 'ready' }
  | { status: 'blocked'; title: string; message: string };

const AUTHORIZATION_REFRESH_INTERVAL_MS = 60_000;

const LoadingSpinner: React.FC = () => (
  <div className="flex h-screen w-full items-center justify-center bg-gray-50">
    <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
  </div>
);

const CompatibilityBlocked: React.FC<{ title: string; message: string }> = ({ title, message }) => (
  <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
    <div className="w-full max-w-lg rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div className="text-sm font-medium uppercase tracking-wide text-red-600">Hosted UI unavailable</div>
      <h1 className="mt-2 text-2xl font-semibold text-gray-950">{title}</h1>
      <p className="mt-3 text-sm leading-6 text-gray-600">{message}</p>
      <div className="mt-5 rounded-md bg-gray-50 p-3 text-sm text-gray-600">
        Update or restart the local ProPR stack, then reload this page.
      </div>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-5 inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        Reload
      </button>
    </div>
  </div>
);

const HostedConnectionBlocked: React.FC<{ title: string; message: string }> = ({ title, message }) => (
  <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
    <div className="w-full max-w-lg rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div className="text-sm font-medium uppercase tracking-wide text-blue-600">Hosted UI</div>
      <h1 className="mt-2 text-2xl font-semibold text-gray-950">{title}</h1>
      <p className="mt-3 text-sm leading-6 text-gray-600">{message}</p>
      <div className="mt-5 rounded-md bg-gray-50 p-3 text-sm text-gray-600">
        Run <code className="font-mono">propr tunnel setup</code> from ProPR Connect, then open the hosted UI link it prints.
      </div>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-5 inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        Reload
      </button>
    </div>
  </div>
);

const PermissionRequired: React.FC<{
  permission: InstancePermission;
  children: React.ReactNode;
}> = ({ permission, children }) => {
  const user = useCurrentUser();
  if (userHasPermission(user, permission)) return children;
  return (
    <div className="mx-auto max-w-2xl py-20 text-center">
      <h1 className="text-2xl font-semibold text-gray-900">Administrator access required</h1>
      <p className="mt-3 text-sm text-gray-600">
        Your instance role does not allow you to manage this installation.
      </p>
    </div>
  );
};

const AppContent: React.FC = () => {
  const { isDemoMode, isLoading: isDemoModeLoading } = useDemoMode();
  // Auth check state - start loading unless already on login page
  const [isLoading, setIsLoading] = useState(window.location.pathname !== '/login');
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);

  const refreshCurrentUser = useCallback(async () => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    const request = getCurrentUser()
      .then(user => { setCurrentUser(user); })
      .finally(() => {
        if (refreshPromiseRef.current === request) refreshPromiseRef.current = null;
      });
    refreshPromiseRef.current = request;
    return request;
  }, []);

  // Perform initial auth check
  useEffect(() => {
    if (isDemoModeLoading) return;

    const checkSession = async () => {
      // Don't check if we are already on login page
      if (window.location.pathname === '/login') {
        setIsLoading(false);
        return;
      }

      try {
        await refreshCurrentUser();
        // Session is valid
        setIsLoading(false);
      } catch (error) {
        // If error is NOT 'Authentication required', we let the app render (to show errors).
        // If it IS 'Authentication required', handleApiResponse handles the redirect,
        // so we keep isLoading=true to prevent UI flash.
        if (error instanceof Error && error.message !== 'Authentication required') {
          setIsLoading(false);
        }
      }
    };

    checkSession();
  }, [isDemoModeLoading, refreshCurrentUser]);

  useEffect(() => {
    const handleAuthorizationChanged = () => {
      void refreshCurrentUser().catch(error => {
        console.error('Failed to refresh instance authorization:', error);
      });
    };
    window.addEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, handleAuthorizationChanged);
    return () => window.removeEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, handleAuthorizationChanged);
  }, [refreshCurrentUser]);

  useEffect(() => {
    if (isDemoMode || window.location.pathname === '/login') return;
    const refreshAuthorization = () => {
      if (document.visibilityState === 'hidden') return;
      void refreshCurrentUser().catch(error => {
        console.error('Failed to synchronize instance authorization:', error);
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshAuthorization();
    };
    const interval = window.setInterval(refreshAuthorization, AUTHORIZATION_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refreshAuthorization);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshAuthorization);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isDemoMode, refreshCurrentUser]);


  // Render spinner while checking auth
  if (isDemoModeLoading || isLoading) return <LoadingSpinner />;

  return (
    <SocketProvider disabled={isDemoMode}>
      <ToastProvider>
        <div className={`flex h-screen flex-col ${isDemoMode ? 'pt-9' : ''}`}>
          <DemoModeBanner />
          <div className="min-h-0 flex-1">
            <AuthProvider user={currentUser} refreshUser={refreshCurrentUser}>
              <Router>
                <Suspense fallback={<LoadingSpinner />}>
                  <Routes>
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/revert" element={<RevertPage />} />
                    <Route
                      path="/"
                      element={
                        <Layout>
                          <Dashboard />
                        </Layout>
                      }
                    />
                    <Route
                      path="/repositories"
                      element={
                        <Layout>
                          <RepositoriesPage />
                        </Layout>
                      }
                    />
                    <Route
                      path="/tasks"
                      element={
                        <Layout>
                          <TasksPage />
                        </Layout>
                      }
                    />
                    <Route
                      path="/tasks/:taskId"
                      element={
                        <Layout>
                          <TasksPage />
                        </Layout>
                      }
                    />
                    <Route
                      path="/studio/new"
                      element={
                        <Layout>
                          <PlanStudioPage isNew />
                        </Layout>
                      }
                    />
                    <Route
                      path="/studio/:draftId"
                      element={
                        <Layout>
                          <PlanStudioPage />
                        </Layout>
                      }
                    />
                    <Route
                      path="/plans"
                      element={
                        <Layout>
                          <PlansPage />
                        </Layout>
                      }
                    />
                    <Route
                      path="/ai-agents"
                      element={
                        <Layout>
                          <PermissionRequired permission="instance.manage_agents">
                            <AiAgentsPage />
                          </PermissionRequired>
                        </Layout>
                      }
                    />
                    <Route
                      path="/settings"
                      element={
                        <Layout>
                          <PermissionRequired permission="instance.manage_settings">
                            <SettingsPage />
                          </PermissionRequired>
                        </Layout>
                      }
                    />
                    <Route
                      path="/admin/members"
                      element={
                        <Layout>
                          <PermissionRequired permission="instance.manage_members">
                            <AccessManagementPage />
                          </PermissionRequired>
                        </Layout>
                      }
                    />
                    <Route
                      path="/summaries/:owner/:repo"
                      element={
                        <Layout>
                          <SummaryBrowserPage />
                        </Layout>
                      }
                    />
                    <Route
                      path="/llm-logs"
                      element={
                        <Layout>
                          <LlmLogsPage />
                        </Layout>
                      }
                    />
                    <Route
                      path="*"
                      element={
                        <Layout>
                          <div className="text-center py-20">
                            <h2 className="text-xl font-semibold text-gray-700 mb-2">Page not found</h2>
                            <p className="text-gray-500 mb-4">This page does not exist or has moved.</p>
                            <a href="/" className="text-primary-600 hover:text-primary-700 underline">
                              Back to dashboard
                            </a>
                          </div>
                        </Layout>
                      }
                    />
                  </Routes>
                </Suspense>
              </Router>
            </AuthProvider>
          </div>
        </div>
      </ToastProvider>
    </SocketProvider>
  );
};

const App: React.FC = () => {
  // The compatibility gate only applies to the hosted UI — a single static bundle
  // serving many per-instance proxies, where the UI and API are versioned
  // independently. On a local/self-hosted origin the UI and API ship together, so
  // there is nothing to gate: start 'ready' (no spinner flash, no network
  // round-trip) and keep local development working (issue #1627).
  const isHosted = isHostedUiOrigin(window.location.hostname);
  const connectionIssue = hostedUiConnectionIssue(
    window.location.hostname,
    window.__PROPR_CONFIG__,
    window.location.search
  );
  const [compatibility, setCompatibility] = useState<CompatibilityState>(
    isHosted && !connectionIssue ? { status: 'checking' } : { status: 'ready' }
  );

  useEffect(() => {
    if (!isHosted || connectionIssue) return;
    let cancelled = false;

    checkProprApiCompatibility()
      .then((result) => {
        if (cancelled) return;
        if (result.compatible) {
          setCompatibility({ status: 'ready' });
          return;
        }
        // An API that predates the compatibility endpoint (reason 'missing')
        // is treated as a soft warning, not a hard wall: during rollout an
        // otherwise-working stack may simply not publish metadata yet, and we
        // don't want to trap mid-upgrade users on a blocking screen. Only a
        // definitive version mismatch (too_old/too_new/unsupported) hard-blocks.
        // TODO(rollout): this 'missing' soft-warning is a temporary v1 allowance
        // (see docs/docs/operations/deployment.md). Once publishing the
        // compatibility contract is a baseline expectation, treat 'missing' as a
        // hard block like any other mismatch.
        if (result.reason === 'missing') {
          console.warn(`[propr] ${result.message}`);
          setCompatibility({ status: 'ready' });
          return;
        }
        setCompatibility({
          status: 'blocked',
          title: 'ProPR version mismatch',
          message: result.message,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // A failed check (network error, API momentarily unreachable at load, an
        // unexpected HTTP status) is treated as transient: render the app rather
        // than hard-blocking it, so the normal auth/demo flow and per-component
        // error handling can surface the problem (and recover once the API is up)
        // instead of trapping the user on a screen with no retry. Only a confirmed
        // incompatibility above blocks.
        const message = error instanceof ProprCompatibilityCheckError || error instanceof Error
          ? error.message
          : 'Cannot check the local ProPR API compatibility.';
        console.warn(`[propr] ProPR compatibility check failed, continuing: ${message}`);
        setCompatibility({ status: 'ready' });
      });

    return () => {
      cancelled = true;
    };
  }, [isHosted, connectionIssue]);

  if (connectionIssue) {
    return <HostedConnectionBlocked title={connectionIssue.title} message={connectionIssue.message} />;
  }
  if (compatibility.status === 'checking') return <LoadingSpinner />;
  if (compatibility.status === 'blocked') {
    return <CompatibilityBlocked title={compatibility.title} message={compatibility.message} />;
  }

  return (
    <DemoModeProvider>
      <AppContent />
    </DemoModeProvider>
  )
}

export default App

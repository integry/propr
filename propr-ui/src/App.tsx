import React, { useEffect, useState } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import RepositoriesPage from './pages/RepositoriesPage'
import TasksPage from './pages/TasksPage'
// TaskPlannerPage removed - all plan routes now use PlanStudioPage
import PlanStudioPage from './pages/PlanStudioPage'
import PlansPage from './pages/PlansPage'
import AiAgentsPage from './pages/AiAgentsPage'
import SettingsPage from './pages/SettingsPage'
import SummaryBrowserPage from './pages/SummaryBrowserPage'
import LlmLogsPage from './pages/LlmLogsPage'
import LoginPage from './pages/LoginPage'
import RevertPage from './pages/RevertPage'
import { ToastProvider } from './components/ui/Toast'
import { SocketProvider } from './contexts/SocketProvider'
import { useDemoMode } from './contexts/DemoModeContext'
import { DemoModeProvider } from './contexts/DemoModeProvider'
import DemoModeBanner from './components/DemoModeBanner'
import './App.css'
import { getCurrentUser } from './api/proprApi'
import { checkProprApiCompatibility, ProprCompatibilityCheckError } from './api/compatibility'
import { isHostedUiOrigin } from './config/runtimeConfig'

type CompatibilityState =
  | { status: 'checking' }
  | { status: 'ready' }
  | { status: 'blocked'; title: string; message: string };

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

const AppContent: React.FC = () => {
  const { isDemoMode, isLoading: isDemoModeLoading } = useDemoMode();
  // Auth check state - start loading unless already on login page
  const [isLoading, setIsLoading] = useState(window.location.pathname !== '/login');

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
        await getCurrentUser();
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
  }, [isDemoModeLoading]);


  // Render spinner while checking auth
  if (isDemoModeLoading || isLoading) return <LoadingSpinner />;

  return (
      <SocketProvider disabled={isDemoMode}>
        <ToastProvider>
          <div className={`flex h-screen flex-col ${isDemoMode ? 'pt-9' : ''}`}>
            <DemoModeBanner />
            <div className="min-h-0 flex-1">
              <Router>
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
                      <AiAgentsPage />
                    </Layout>
                  }
                />
                <Route
                  path="/settings"
                  element={
                    <Layout>
                      <SettingsPage />
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
              </Routes>
              </Router>
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
  const [compatibility, setCompatibility] = useState<CompatibilityState>(
    isHosted ? { status: 'checking' } : { status: 'ready' }
  );

  useEffect(() => {
    if (!isHosted) return;
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
  }, [isHosted]);

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

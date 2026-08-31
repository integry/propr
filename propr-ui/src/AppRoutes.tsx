import { lazy, Suspense, type ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import RouteChunkErrorBoundary from './components/RouteChunkErrorBoundary';
import { useCurrentUser, userHasPermission } from './contexts/AuthContext';
import type { InstancePermission } from './api/proprTypes';
import { NotFoundRouteContent } from './AppRouteUtilities';

const AiAgentsPage = lazy(() => import('./pages/AiAgentsPage'));
const AccessManagementPage = lazy(() => import('./pages/AccessManagementPage'));
const Dashboard = lazy(() => import('./components/Dashboard'));
const GoalCreatePage = lazy(() => import('./pages/GoalCreatePage'));
const GoalsPage = lazy(() => import('./pages/GoalsPage'));
const LlmLogsPage = lazy(() => import('./pages/LlmLogsPage'));
const InboxPage = lazy(() => import('./pages/InboxPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const PlansPage = lazy(() => import('./pages/PlansPage'));
const PlanStudioPage = lazy(() => import('./pages/PlanStudioPage'));
const RepositoriesPage = lazy(() => import('./pages/RepositoriesPage'));
const RevertPage = lazy(() => import('./pages/RevertPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const SummaryBrowserPage = lazy(() => import('./pages/SummaryBrowserPage'));
const TasksPage = lazy(() => import('./pages/TasksPage'));

const LoadingSpinner = () => (
  <div className="flex h-screen w-full items-center justify-center bg-gray-50" role="status" aria-label="Loading page">
    <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
  </div>
);

const PageLayout = ({ children }: { children: ReactNode }) => <Layout>{children}</Layout>;

const PermissionRequired = ({ permission, children }: { permission: InstancePermission; children: ReactNode }) => {
  const user = useCurrentUser();
  if (userHasPermission(user, permission)) return children;
  return (
    <div className="mx-auto max-w-2xl py-20 text-center">
      <h1 className="text-2xl font-semibold text-gray-900">Administrator access required</h1>
      <p className="mt-3 text-sm text-gray-600">Your instance role does not allow you to manage this installation.</p>
    </div>
  );
};

const AppRoutes = () => (
  <RouteChunkErrorBoundary>
    <Suspense fallback={<LoadingSpinner />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/revert" element={<RevertPage />} />
        <Route path="/" element={<PageLayout><Dashboard /></PageLayout>} />
        <Route path="/inbox" element={<PageLayout><InboxPage /></PageLayout>} />
        <Route path="/goals" element={<PageLayout><GoalsPage /></PageLayout>} />
        <Route path="/goals/new" element={<PageLayout><GoalCreatePage /></PageLayout>} />
        <Route path="/repositories" element={<PageLayout><RepositoriesPage /></PageLayout>} />
        <Route path="/tasks" element={<PageLayout><TasksPage /></PageLayout>} />
        <Route path="/tasks/:taskId" element={<PageLayout><TasksPage /></PageLayout>} />
        <Route path="/studio/new" element={<PageLayout><PlanStudioPage isNew /></PageLayout>} />
        <Route path="/studio/:draftId" element={<PageLayout><PlanStudioPage /></PageLayout>} />
        <Route path="/plans" element={<PageLayout><PlansPage /></PageLayout>} />
        <Route path="/ai-agents" element={<PageLayout><PermissionRequired permission="instance.manage_agents"><AiAgentsPage /></PermissionRequired></PageLayout>} />
        <Route path="/settings" element={<PageLayout><SettingsPage /></PageLayout>} />
        <Route path="/admin/members" element={<PageLayout><PermissionRequired permission="instance.manage_members"><AccessManagementPage /></PermissionRequired></PageLayout>} />
        <Route path="/summaries/:owner/:repo" element={<PageLayout><SummaryBrowserPage /></PageLayout>} />
        <Route path="/llm-logs" element={<PageLayout><LlmLogsPage /></PageLayout>} />
        <Route path="*" element={<PageLayout><NotFoundRouteContent /></PageLayout>} />
      </Routes>
    </Suspense>
  </RouteChunkErrorBoundary>
);

export default AppRoutes;

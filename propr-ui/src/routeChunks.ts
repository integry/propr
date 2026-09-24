import { lazy } from 'react';

const preloadable = <Module,>(loadModule: () => Promise<Module>) => {
  let request: Promise<Module> | undefined;
  return () => {
    request ??= loadModule();
    return request;
  };
};

const loadAiAgentsPage = preloadable(() => import('./pages/AiAgentsPage'));
const loadAccessManagementPage = preloadable(() => import('./pages/AccessManagementPage'));
const loadAnalyticsPage = preloadable(() => import('./pages/AnalyticsPage'));
const loadDashboard = preloadable(() => import('./components/Dashboard'));
const loadLlmLogsPage = preloadable(() => import('./pages/LlmLogsPage'));
const loadInboxPage = preloadable(() => import('./pages/InboxPage'));
const loadLoginPage = preloadable(() => import('./pages/LoginPage'));
const loadDesktopPairingPage = preloadable(() => import('./pages/DesktopPairingPage'));
const loadPlansPage = preloadable(() => import('./pages/PlansPage'));
const loadPlanStudioPage = preloadable(() => import('./pages/PlanStudioPage'));
const loadRepositoriesPage = preloadable(() => import('./pages/RepositoriesPage'));
const loadRevertPage = preloadable(() => import('./pages/RevertPage'));
const loadSettingsPage = preloadable(() => import('./pages/SettingsPage'));
const loadSummaryBrowserPage = preloadable(() => import('./pages/SummaryBrowserPage'));
const loadTasksPage = preloadable(() => import('./pages/TasksPage'));
const loadGoalsPage = preloadable(() => import('./pages/GoalsPage'));

export const AiAgentsPage = lazy(loadAiAgentsPage);
export const AccessManagementPage = lazy(loadAccessManagementPage);
export const AnalyticsPage = lazy(loadAnalyticsPage);
export const Dashboard = lazy(loadDashboard);
export const LlmLogsPage = lazy(loadLlmLogsPage);
export const InboxPage = lazy(loadInboxPage);
export const LoginPage = lazy(loadLoginPage);
export const DesktopPairingPage = lazy(loadDesktopPairingPage);
export const PlansPage = lazy(loadPlansPage);
export const PlanStudioPage = lazy(loadPlanStudioPage);
export const RepositoriesPage = lazy(loadRepositoriesPage);
export const RevertPage = lazy(loadRevertPage);
export const SettingsPage = lazy(loadSettingsPage);
export const SummaryBrowserPage = lazy(loadSummaryBrowserPage);
export const TasksPage = lazy(loadTasksPage);
export const GoalsPage = lazy(loadGoalsPage);

const initialRouteChunks: Array<{
  matches: (pathname: string) => boolean;
  load: () => Promise<unknown>;
}> = [
  { matches: pathname => pathname === '/', load: loadDashboard },
  { matches: pathname => pathname === '/login', load: loadLoginPage },
  { matches: pathname => pathname === '/desktop/pairing', load: loadDesktopPairingPage },
  { matches: pathname => pathname === '/revert', load: loadRevertPage },
  { matches: pathname => pathname === '/inbox', load: loadInboxPage },
  { matches: pathname => pathname === '/repositories', load: loadRepositoriesPage },
  { matches: pathname => pathname === '/tasks' || pathname.startsWith('/tasks/'), load: loadTasksPage },
  { matches: pathname => pathname === '/goals' || pathname.startsWith('/goals/'), load: loadGoalsPage },
  { matches: pathname => pathname === '/studio/new' || pathname.startsWith('/studio/'), load: loadPlanStudioPage },
  { matches: pathname => pathname === '/plans', load: loadPlansPage },
  { matches: pathname => pathname === '/ai-agents', load: loadAiAgentsPage },
  { matches: pathname => pathname === '/settings', load: loadSettingsPage },
  { matches: pathname => pathname === '/admin/members', load: loadAccessManagementPage },
  { matches: pathname => pathname.startsWith('/summaries/'), load: loadSummaryBrowserPage },
  { matches: pathname => pathname === '/llm-logs', load: loadLlmLogsPage },
  { matches: pathname => pathname === '/analytics', load: loadAnalyticsPage },
];

/**
 * Discovers only the route selected by the current URL while authentication is
 * still pending. Loading JavaScript cannot expose route data, and the shared
 * promise keeps Suspense from issuing a second chunk request after auth.
 */
export const preloadInitialRouteChunk = (pathname: string): void => {
  const chunk = initialRouteChunks.find(candidate => candidate.matches(pathname));
  if (chunk) void chunk.load().catch(() => undefined);
};

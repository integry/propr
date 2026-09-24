import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, ScrollText, ListTodo, BookMarked, Bot, ChartColumn, Cpu, Settings, ShieldCheck, Inbox, LogOut, Target, TriangleAlert } from 'lucide-react';
import { logout } from '../api/proprApi';
import { useDynamicFavicon } from '../hooks/useDynamicFavicon';
import { useSystemReadiness } from '../hooks/useSystemReadiness';
import { useToast } from './ui/useToast';
import { MenuIcon, CloseIcon } from './icons/LayoutIcons';
import { SIDEBAR_ICON_STROKE_WIDTH, SIDEBAR_ICON_STROKE_CLASS } from './icons/sidebarIconStroke';
import { DESKTOP_UI_COMMAND_EVENT } from '../desktop/useDesktopNativeCommands';
import GlobalHeader from './GlobalHeader';
import AgentTankSidebar from './AgentTankSidebar';
import { useSocket } from '../contexts/useSocket';
import { useDemoMode } from '../contexts/DemoModeContext';
import { QueueStatsUpdatePayload, IndexingUpdatePayload, DraftUpdatePayload } from '@propr/shared';
import { useCurrentUser, userHasPermission } from '../contexts/AuthContext';
import { ConnectCapacityBanner } from './ConnectPlusBanner';
import { useNotificationCenter } from '../contexts/NotificationCenterContext';
import { publicAssetUrl } from '../config/runtimeMode';
import { DesktopInstanceSelector } from '../desktop/DesktopInstanceSelector';
import { useDesktop } from '../desktop/DesktopContext';
import UserAvatar from './UserAvatar';
import VoiceBriefingControl from './VoiceBriefingControl';
import { HeaderScopeSlotContext } from './headerScopeSlot';

interface LayoutProps {
  children: React.ReactNode;
}

interface NavItem {
  name: string;
  href: string;
  // All nav icons come from lucide so a shared strokeWidth keeps line weights uniform.
  icon: React.FC<{ className?: string; strokeWidth?: number | string }>;
}

interface NavigationState {
  currentPath: string;
  desktop: boolean;
  hasAgents: boolean;
  hasRepos: boolean;
  hasTasks: boolean;
  taskCount: number;
  goalCount: number;
  generatingPlansCount: number;
  unreadCount: number | null;
}

const CORE_NAVIGATION: NavItem[] = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Inbox', href: '/inbox', icon: Inbox },
  { name: 'Tasks', href: '/tasks', icon: ListTodo },
  { name: 'Goals', href: '/goals', icon: Target },
  { name: 'Plans', href: '/plans', icon: ScrollText },
];

function getResourceNavigation(canManageAgents: boolean, canManageMembers: boolean): NavItem[] {
  const navigation: NavItem[] = [{ name: 'Repositories', href: '/repositories', icon: BookMarked }];
  if (canManageAgents) navigation.push({ name: 'Coding Agents', href: '/ai-agents', icon: Bot });
  navigation.push(
    { name: 'Analytics', href: '/analytics', icon: ChartColumn },
    { name: 'LLM Log', href: '/llm-logs', icon: Cpu },
    { name: 'Settings', href: '/settings', icon: Settings },
  );
  if (canManageMembers) navigation.push({ name: 'Access', href: '/admin/members', icon: ShieldCheck });
  return navigation;
}

function isNavigationItemActive(currentPath: string, itemPath: string): boolean {
  // Dashboard should only be active on exact match.
  if (itemPath === '/') return currentPath === '/';

  // Plans also owns studio routes.
  if (itemPath === '/plans') {
    return currentPath === '/plans' || currentPath.startsWith('/plans/') || currentPath.startsWith('/studio');
  }

  // Repository content browsing includes summaries routes.
  if (itemPath === '/repositories') {
    return currentPath === '/repositories' || currentPath.startsWith('/repositories/') || currentPath.startsWith('/summaries');
  }

  return currentPath === itemPath || currentPath.startsWith(itemPath + '/');
}

// Single badge component for all nav counts: forms a circle for one digit and
// stretches horizontally for wider content (e.g. "99+") with the same radius and padding.
// The parent nav row is `flex items-center justify-between`, which keeps the badge on
// the same horizontal center line as the label.
//
// The digits are centered by the flex box alone: `leading-none` collapses the line
// box onto the glyphs (digits have no descender, so their ink already centers on the
// em box), and no vertical nudge is applied on top of it — a nudge is what made the
// numbers sit low in the pill.
function NavBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-4 min-w-4 flex-none items-center justify-center rounded-full bg-primary-500 px-1 text-[10px] font-bold leading-none text-white">
      {children}
    </span>
  );
}

function WorkCountBadge({ name, taskCount, goalCount }: { name: string; taskCount: number; goalCount: number }) {
  const count = name === 'Tasks' ? taskCount : name === 'Goals' ? goalCount : 0;
  if (count <= 0) return null;
  return <NavBadge>{count}</NavBadge>;
}

function getReadinessMessage(name: string, state: NavigationState): string | null {
  if (name === 'Repositories' && !state.hasRepos) return 'No repositories configured';
  if (name === 'Coding Agents' && !state.hasAgents) return 'No AI agents configured';
  if (name === 'Tasks' && state.taskCount === 0 && !state.hasTasks && state.hasAgents && state.hasRepos) {
    return 'No tasks created yet';
  }
  return null;
}

function ReadinessIndicator({ message, desktop }: { message: string | null; desktop: boolean }) {
  if (!message) return null;
  if (!desktop) return <span className="w-2 h-2 flex-none rounded-full bg-amber-500" title={message} />;
  return (
    <span className="flex h-4 w-4 flex-none items-center justify-center text-amber-600" role="img" aria-label={message} title={message}>
      <TriangleAlert className={`${SIDEBAR_ICON_STROKE_CLASS} h-3.5 w-3.5`} strokeWidth={SIDEBAR_ICON_STROKE_WIDTH} aria-hidden="true" />
    </span>
  );
}

function InboxBadge({ name, unreadCount }: { name: string; unreadCount: number | null }) {
  if (name !== 'Inbox' || unreadCount === null || unreadCount <= 0) return null;
  return <NavBadge>{unreadCount > 99 ? '99+' : unreadCount}</NavBadge>;
}

function PlansBadge({ name, count }: { name: string; count: number }) {
  if (name !== 'Plans' || count <= 0) return null;
  return <NavBadge>{count}</NavBadge>;
}

function getNavigationItemClassName(desktop: boolean, active: boolean): string {
  const dimensions = desktop
    ? 'mx-2 rounded-[6px] border-0 px-2 py-1.5 tracking-tight'
    : 'border-l-4 px-4 py-2';
  if (active) {
    return `${dimensions} ${desktop
      ? 'bg-black/5 font-normal text-slate-900'
      : 'bg-slate-50 font-medium text-slate-900 border-primary-600'}`;
  }
  return `${dimensions} ${desktop
    ? 'font-normal text-slate-600 hover:bg-slate-900/5 hover:text-slate-900'
    : 'font-normal text-gray-600 hover:bg-gray-50 hover:text-gray-900 border-transparent'}`;
}

function NavigationItem({ item, state }: { item: NavItem; state: NavigationState }) {
  const readinessMessage = getReadinessMessage(item.name, state);
  const active = isNavigationItemActive(state.currentPath, item.href);
  return (
    <Link
      to={item.href}
      className={`flex items-center justify-between text-[13px] leading-5 transition-colors duration-150 ${getNavigationItemClassName(state.desktop, active)}`}
    >
      <span className="flex min-w-0 items-center">
        <item.icon className={`${SIDEBAR_ICON_STROKE_CLASS} mr-2.5 h-4 w-4 flex-none`} strokeWidth={SIDEBAR_ICON_STROKE_WIDTH} />
        <span className="truncate">{item.name}</span>
      </span>
      {/* Counts and readiness indicators share the trailing rail. */}
      <span className="flex flex-none items-center justify-end gap-1.5">
        <ReadinessIndicator message={readinessMessage} desktop={state.desktop} />
        <WorkCountBadge name={item.name} taskCount={state.taskCount} goalCount={state.goalCount} />
        <InboxBadge name={item.name} unreadCount={state.unreadCount} />
        <PlansBadge name={item.name} count={state.generatingPlansCount} />
      </span>
    </Link>
  );
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const { addToast } = useToast();
  const { isDemoMode } = useDemoMode();
  const { isConnected, subscribeToQueueStats, unsubscribeFromQueueStats, subscribeToIndexingUpdates, unsubscribeFromIndexingUpdates, onQueueStatsUpdate, onIndexingUpdate, onDraftUpdate } = useSocket();
  const [activeQueueCount, setActiveQueueCount] = useState<number>(0);
  const [activeGoalCount, setActiveGoalCount] = useState<number>(0);
  const [generatingPlansCount, setGeneratingPlansCount] = useState<number>(0);
  const user = useCurrentUser();
  const { unreadCount } = useNotificationCenter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const desktop = useDesktop();
  const [desktopSidebarHidden, setDesktopSidebarHidden] = useState(false);
  const hideSidebar = desktop && desktopSidebarHidden;
  // The toolbar's scope slot, handed to the routed page so it can mount its
  // filter beside search instead of spending a row of its own on it.
  const [headerScopeSlot, setHeaderScopeSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!desktop) return;
    const handleCommand = (event: Event) => {
      if ((event as CustomEvent).detail === 'toggle-sidebar') {
        if (window.matchMedia('(min-width: 1024px)').matches) setDesktopSidebarHidden(value => !value);
        else setIsSidebarOpen(value => !value);
      }
    };
    window.addEventListener(DESKTOP_UI_COMMAND_EVENT, handleCommand);
    return () => window.removeEventListener(DESKTOP_UI_COMMAND_EVENT, handleCommand);
  }, [desktop]);
  // Track repository indexing statuses for toast notifications
  const repoStatusesRef = useRef<Map<string, string>>(new Map());

  // Keep the favicon's existing aggregate active-work count.
  useDynamicFavicon(activeQueueCount);

  // Track system readiness for proactive sidebar indicators
  const { hasAgents, hasRepos, hasTasks } = useSystemReadiness();

  // The queue's active count aggregates task, plan, and goal jobs. Give each
  // first-class work type its own sidebar count.
  const displayTaskCount = Math.max(0, activeQueueCount - generatingPlansCount - activeGoalCount);

  const canManageAgents = userHasPermission(user, 'instance.manage_agents');
  const resourceNavigation = getResourceNavigation(
    canManageAgents,
    userHasPermission(user, 'instance.manage_members'),
  );
  const navigationState: NavigationState = {
    currentPath: location.pathname,
    desktop: Boolean(desktop),
    hasAgents,
    hasRepos,
    hasTasks,
    taskCount: displayTaskCount,
    goalCount: activeGoalCount,
    generatingPlansCount,
    unreadCount,
  };

  // Close sidebar on route change (mobile)
  useEffect(() => {
    setIsSidebarOpen(false);
  }, [location]);

  // Handle queue stats updates via WebSocket
  const handleQueueStatsUpdate = useCallback((payload: QueueStatsUpdatePayload) => {
    const activeCount = payload.stats.active || 0;
    setActiveQueueCount(activeCount);
    setActiveGoalCount(Math.min(activeCount, Math.max(0, payload.stats.activeGoals || 0)));
  }, []);

  // Handle indexing updates via WebSocket for toast notifications
  const handleIndexingUpdate = useCallback((payload: IndexingUpdatePayload) => {
    const previousStatus = repoStatusesRef.current.get(payload.repository);
    const currentStatus = payload.phase;

    // Show toast when transitioning from 'indexing' to 'failed'
    if (previousStatus === 'indexing' && currentStatus === 'failed') {
      addToast({
        type: 'error',
        message: `Indexing failed for ${payload.repository}`,
      });
    }

    // Update the tracked status
    repoStatusesRef.current.set(payload.repository, currentStatus);
  }, [addToast]);

  // Handle draft updates to track generating plans count
  const handleDraftUpdate = useCallback((payload: DraftUpdatePayload) => {
    // When a draft starts or completes, adjust the count
    // The draft step indicates the phase: 'relevance', 'context', 'llm', etc.
    if (payload.status === 'in_progress' && payload.step === 'relevance') {
      // A new plan generation started
      setGeneratingPlansCount(prev => prev + 1);
    } else if (payload.status === 'completed' || payload.status === 'failed') {
      // A plan generation finished
      setGeneratingPlansCount(prev => Math.max(0, prev - 1));
    }
  }, []);

  // Subscribe to WebSocket events when connected
  useEffect(() => {
    if (!isConnected) return;

    // Subscribe to queue stats and indexing updates
    subscribeToQueueStats();
    subscribeToIndexingUpdates();

    return () => {
      unsubscribeFromQueueStats();
      unsubscribeFromIndexingUpdates();
    };
  }, [isConnected, subscribeToQueueStats, unsubscribeFromQueueStats, subscribeToIndexingUpdates, unsubscribeFromIndexingUpdates]);

  // Register WebSocket event listeners
  useEffect(() => {
    const unsubscribeQueueStats = onQueueStatsUpdate(handleQueueStatsUpdate);
    const unsubscribeIndexing = onIndexingUpdate(handleIndexingUpdate);
    const unsubscribeDraft = onDraftUpdate(handleDraftUpdate);

    return () => {
      unsubscribeQueueStats();
      unsubscribeIndexing();
      unsubscribeDraft();
    };
  }, [onQueueStatsUpdate, onIndexingUpdate, onDraftUpdate, handleQueueStatsUpdate, handleIndexingUpdate, handleDraftUpdate]);

  // Handler for menu toggle
  const handleMenuToggle = () => {
    setDesktopSidebarHidden(false);
    setIsSidebarOpen(true);
  };

  // Hover ink for the account block: translucent on the desktop app's tinted
  // macOS-style wash, opaque gray on the web's white sidebar.
  const profileHoverInk = desktop ? 'hover:bg-slate-900/5' : 'hover:bg-slate-100';

  return (
    <div className={`${hideSidebar ? 'desktop-sidebar-hidden ' : ''}desktop-shell flex h-full min-h-0 flex-col overflow-hidden bg-light-100 relative`}>
      <div className="desktop-shell-content relative flex min-h-0 flex-1 overflow-hidden">
      {desktop && <div className="desktop-connected-drag-region" aria-hidden="true" />}
      {/* Mobile Overlay */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-gray-600 bg-opacity-75 z-20 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar - Responsive */}
      {!hideSidebar && <aside className={`
        fixed lg:static inset-y-0 left-0 z-30
        desktop-sidebar flex flex-col w-60 bg-white border-r border-gray-200 shadow-sm
        transform transition-transform duration-200 ease-in-out
        ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        {desktop && <div className="desktop-sidebar-drag-region" aria-hidden="true" />}
        {!desktop && <div className="desktop-sidebar-header flex flex-none items-center justify-between px-4 py-4 sm:py-6 h-12 sm:h-16">
          <Link to="/" className="flex items-center" aria-label="ProPR dashboard">
            <img src={publicAssetUrl('/media/logo-and-name.png')} alt="ProPR" className="h-8 w-auto" />
          </Link>
          <button
            onClick={() => setIsSidebarOpen(false)}
            className="lg:hidden text-gray-500 hover:text-gray-700 p-1"
            aria-label="Close menu"
          >
            <CloseIcon className={`${SIDEBAR_ICON_STROKE_CLASS} w-6 h-6`} />
          </button>
        </div>}
        {desktop && <DesktopInstanceSelector transportReady={isConnected && user !== null} />}
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Whitespace separates navigation from the workspace control. */}
          <nav className="flex min-h-0 flex-col overflow-y-auto pt-2 pb-1">
            <div className="flex flex-col gap-0.5">
              {CORE_NAVIGATION.map(item => <NavigationItem key={item.name} item={item} state={navigationState} />)}
            </div>
            {/* Whitespace spacer (no divider) between the core-workflow and
                technical-resources zones. */}
            <div className="mt-6 flex flex-col gap-0.5">
              {resourceNavigation.map(item => <NavigationItem key={item.name} item={item} state={navigationState} />)}
            </div>
          </nav>
          {/* Usage and account information stay at the bottom, with metadata
              last. mt-auto absorbs the space below navigation. */}
          <div className="mt-auto flex flex-none flex-col">
          {(isDemoMode || canManageAgents) && (
            <AgentTankSidebar allowManualRefresh={!isDemoMode} scrollable={Boolean(desktop)} className="desktop-sidebar-usage" />
          )}
          {user && (
            // The interactive account block is its own group, detached from
            // the usage widget by an mt-4 whitespace spacer —
            // zone separation is whitespace, never a line. pr-2.5 (10px) + the
            // 6px glyph inset inside the 28px logout button puts the logout
            // icon's right edge on the sidebar's shared 16px rail, aligned with
            // the nav badges and the Usage refresh icon.
            <div className="desktop-sidebar-profile mt-4 flex flex-none items-center justify-between gap-2 py-2 pl-3 pr-2.5">
              <a
                href={`https://github.com/${user.username}`}
                target="_blank"
                rel="noopener noreferrer"
                className={`group flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 transition-colors ${profileHoverInk}`}
              >
                <UserAvatar
                  user={user}
                  className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-gray-200 object-cover text-[10px] font-bold transition-colors group-hover:border-gray-300"
                  fallbackClassName="bg-primary-100 text-primary-600 group-hover:bg-primary-200"
                />
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-[13px] font-medium text-slate-700">
                    {user.displayName || user.username}
                  </span>
                  <span className="block truncate text-[11px] text-slate-500">@{user.username}</span>
                </span>
              </a>
              <button
                type="button"
                onClick={logout}
                className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600"
                aria-label="Logout"
                title="Logout"
              >
                <LogOut className={`${SIDEBAR_ICON_STROKE_CLASS} h-4 w-4`} strokeWidth={SIDEBAR_ICON_STROKE_WIDTH} aria-hidden="true" />
              </button>
            </div>
          )}
          {/* Desktop keeps this metadata in the native About dialog. On web,
              metadata sits flush on the sidebar's shared 16px left rail (the same
              rail as the nav labels and the Usage heading) rather than being
              indented to the profile's text column. */}
          {!desktop && <footer className="mt-4 px-4 pb-2 leading-tight space-y-1">
            {/* The version is the datum developers scan for, so it sits one
                contrast step above the secondary copyright line. */}
            <div className="text-[11px] text-slate-500">
              <a
                href="https://propr.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-slate-700 hover:underline"
              >
                ProPR
              </a>{' '}
              v{__APP_VERSION__}
            </div>
            <div className="text-[10px] text-slate-400">© {new Date().getFullYear()} Rinalds Uzkalns</div>
          </footer>}
          </div>
        </div>
      </aside>}

      {/* Main content wrapper */}
      <div className="desktop-main-content flex-1 flex flex-col min-w-0">
        {/* GlobalHeader replaces the old inline header */}
        <GlobalHeader
          user={user}
          onLogout={logout}
          onMenuToggle={handleMenuToggle}
          MenuIcon={MenuIcon}
          isDemoMode={isDemoMode}
          inboxUnreadCount={unreadCount}
          scopeSlotRef={setHeaderScopeSlot}
        />

        {!isDemoMode && <ConnectCapacityBanner />}

        <main className="mobile-content-clearance flex-1 overflow-y-auto md:pb-0">
          <HeaderScopeSlotContext.Provider value={headerScopeSlot}>
            {children}
          </HeaderScopeSlotContext.Provider>
        </main>

        <VoiceBriefingControl />
      </div>
      </div>
    </div>
  );
};

export default Layout;

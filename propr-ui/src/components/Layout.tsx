import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LogOut } from 'lucide-react';
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
import { SidebarNavigation, type NavigationState } from './SidebarNavigation';

interface LayoutProps {
  children: React.ReactNode;
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
  const navigationPermissions = {
    canManageAgents,
    canManageMembers: userHasPermission(user, 'instance.manage_members'),
    // The MCP access log needs the permission its admin endpoints require.
    canReadMcpLog: userHasPermission(user, 'instance.manage_settings'),
  };
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
          <SidebarNavigation state={navigationState} permissions={navigationPermissions} />
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

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { DESKTOP_UI_COMMAND_EVENT } from '../desktop/useDesktopNativeCommands';
import { useDesktop } from '../desktop/DesktopContext';
import GlobalSearch from './GlobalSearch';
import QuickAddTodo from './QuickAddTodo';
import { useHeaderStats, type HeaderStats } from '../hooks/useHeaderStats';
import {
  SystemHealth,
  ActivePlansButton,
  TasksButton,
} from './GlobalHeaderComponents';
import type { CurrentUser } from '../api/proprTypes';
import MobileBottomNavigation from './MobileBottomNavigation';

interface GlobalHeaderProps {
  user: CurrentUser | null;
  onLogout: () => void;
  onMenuToggle: () => void;
  MenuIcon: React.FC<{ className?: string }>;
  isDemoMode?: boolean;
  headerStatsOverride?: Pick<HeaderStats, 'runningCount' | 'runningItems' | 'activePlans' | 'reviewGroups' | 'systemHealth'> & {
    activityStatus?: HeaderStats['activityStatus'];
    resourceStatuses?: HeaderStats['resourceStatuses'];
    dismissPlan?: HeaderStats['dismissPlan'];
    dismissTask?: HeaderStats['dismissTask'];
  };
  newPlanPressedOverride?: boolean;
  inboxUnreadCount?: number | null;
  /** Receives the element a page portals its scope control into, left of search. */
  scopeSlotRef?: React.Ref<HTMLDivElement>;
}

function resolveHeaderStats(
  override: GlobalHeaderProps['headerStatsOverride'],
  stats: HeaderStats
) {
  return {
    runningCount: override?.runningCount ?? stats.runningCount,
    runningItems: override?.runningItems ?? stats.runningItems,
    activityStatus: override?.activityStatus ?? stats.activityStatus,
    resourceStatuses: override?.resourceStatuses ?? stats.resourceStatuses,
    activePlans: override?.activePlans ?? stats.activePlans,
    reviewGroups: override?.reviewGroups ?? stats.reviewGroups,
    systemHealth: override?.systemHealth ?? stats.systemHealth,
    dismissPlan: override?.dismissPlan ?? stats.dismissPlan,
    dismissTask: override?.dismissTask ?? stats.dismissTask,
  };
}

function useHeaderKeyboardShortcuts(
  searchInputRef: React.RefObject<HTMLInputElement | null>,
  setQuickAddOpen: React.Dispatch<React.SetStateAction<boolean>>
) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.altKey && e.key === 't') {
        e.preventDefault();
        setQuickAddOpen(true);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [searchInputRef, setQuickAddOpen]);
}

const GlobalHeader: React.FC<GlobalHeaderProps> = ({ user, onLogout, onMenuToggle, MenuIcon, isDemoMode = false, headerStatsOverride, newPlanPressedOverride = false, inboxUnreadCount = null, scopeSlotRef }) => {
  const navigate = useNavigate();
  const desktop = useDesktop();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [searchRequest, setSearchRequest] = useState(0);

  const headerStats = useHeaderStats();
  const { activePlans, reviewGroups, systemHealth, dismissPlan, dismissTask, resourceStatuses } = resolveHeaderStats(headerStatsOverride, headerStats);

  const handleNewPlan = useCallback(() => {
    if (isDemoMode) return;
    navigate('/tasks/new');
  }, [isDemoMode, navigate]);

  useHeaderKeyboardShortcuts(searchInputRef, setQuickAddOpen);
  useEffect(() => {
    if (!desktop) return;
    const handleCommand = (event: Event) => {
      if ((event as CustomEvent).detail === 'search') setSearchRequest(value => value + 1);
    };
    window.addEventListener(DESKTOP_UI_COMMAND_EVENT, handleCommand);
    return () => window.removeEventListener(DESKTOP_UI_COMMAND_EVENT, handleCommand);
  }, [desktop]);

  useEffect(() => {
    if (searchRequest) searchInputRef.current?.focus();
  }, [searchRequest]);

  const newPlanBg = newPlanPressedOverride ? 'bg-teal-800' : 'bg-teal-600';
  const newPlanTitle = isDemoMode ? 'Demo mode is read-only' : 'New Task';

  return (
    <>
    {/* Global navigation owns app-wide dropdowns, so its stacking context must stay
        above route-level sticky headers such as task details summaries. */}
    <header aria-label="Application toolbar" className="desktop-content-toolbar sticky top-0 z-40 hidden h-14 grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(max-content,1fr)] items-stretch border-b border-slate-200 bg-slate-50 md:grid">
      <div className="flex min-w-0 items-stretch justify-self-start">
        <div className="flex items-center px-2 lg:hidden">
          <button
            onClick={onMenuToggle}
            className="p-2 text-gray-500 hover:text-gray-700"
            aria-label="Open menu"
          >
            <MenuIcon className="h-6 w-6" />
          </button>
        </div>
        <div className="flex items-stretch">
          <ActivePlansButton activePlans={activePlans} onDismissPlan={dismissPlan} status={resourceStatuses?.drafts} />
          <div className="h-[60%] w-px self-center bg-slate-200" />
          <TasksButton taskGroups={reviewGroups} onDismissTask={dismissTask} status={resourceStatuses?.tasks} />
        </div>
      </div>

      {/*
        The center column is search plus whatever scope control the current
        page mounts immediately to its left (the Dashboard's repository
        filter). The slot collapses when empty, so on every other page the
        column is search alone at its usual 16rem / 20rem.

        The side columns never shrink below their buttons; when the row is
        short of width it is search that gives way, rather than the side
        groups sliding underneath it. Below `lg` the row has no width left to
        give, so the slot is not drawn and the page keeps its scope control in
        its own content.
      */}
      <div className="flex min-w-0 items-center justify-center gap-2 px-2">
        <div ref={scopeSlotRef} data-testid="header-scope-slot" className="hidden flex-none items-center lg:flex lg:empty:hidden" />
        <div className="w-60 min-w-0 xl:w-[19rem]">
          <GlobalSearch inputRef={searchInputRef} />
        </div>
      </div>

      <div className="flex items-stretch gap-2 justify-self-end pl-3">
        <div className="flex items-center">
          <QuickAddTodo
            externalOpen={quickAddOpen}
            onExternalOpenHandled={() => setQuickAddOpen(false)}
            disabled={isDemoMode}
          />
        </div>
        <div className="flex items-center">
          <button
            onClick={handleNewPlan}
            disabled={isDemoMode}
            title={newPlanTitle}
            className={`flex items-center gap-2 whitespace-nowrap rounded-lg border-0 px-3 py-1.5 text-white text-sm font-medium hover:bg-teal-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed xl:px-4 ${newPlanBg}`}
          >
            <Zap className="w-4 h-4" />
            <span>New Task</span>
          </button>
        </div>
        <details className="relative self-center text-sm">
          <summary aria-label="More creation options" className="list-none cursor-pointer px-2 py-2">⌄</summary>
          <div className="absolute right-0 w-36 rounded border border-slate-200 bg-white p-1 shadow-lg">
            <button disabled={isDemoMode} onClick={() => navigate('/studio/new')} className="block w-full p-2 text-left hover:bg-slate-50">New Plan</button>
            <button disabled={isDemoMode} onClick={() => navigate('/goals?new=1')} className="block w-full p-2 text-left hover:bg-slate-50">New Goal</button>
          </div>
        </details>
        <SystemHealth systemHealth={systemHealth} />
      </div>
    </header>
    <MobileBottomNavigation
      user={user}
      onLogout={onLogout}
      isDemoMode={isDemoMode}
      unreadCount={inboxUnreadCount}
      systemHealth={systemHealth}
    />
    </>
  );
};

export default GlobalHeader;

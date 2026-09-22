import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ScrollText, Target, Zap } from 'lucide-react';
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

interface NewWorkButtonProps {
  isDemoMode: boolean;
  pressed: boolean;
}

/** "New Task" is the primary way to start work; plans and goals are alternatives. */
const NewWorkButton: React.FC<NewWorkButtonProps> = ({ isDemoMode, pressed }) => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const go = (path: string) => {
    setOpen(false);
    if (!isDemoMode) navigate(path);
  };
  const background = pressed ? 'bg-teal-800' : 'bg-teal-600';
  const title = isDemoMode ? 'Demo mode is read-only' : 'New Task';

  return (
    <div ref={containerRef} className="relative flex items-center">
      <button
        onClick={() => go('/tasks/new')}
        disabled={isDemoMode}
        title={title}
        className={`flex items-center gap-2 whitespace-nowrap rounded-l-lg border-0 px-3 py-1.5 text-white text-sm font-medium hover:bg-teal-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed xl:px-4 ${background}`}
      >
        <Zap className="w-4 h-4" aria-hidden="true" />
        <span>New Task</span>
      </button>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        disabled={isDemoMode}
        aria-label="More ways to start work"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center rounded-r-lg border-0 border-l border-teal-500 px-1.5 py-2 text-white hover:bg-teal-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed ${background}`}
      >
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" aria-label="Start work" className="desktop-toolbar-popover absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          <button role="menuitem" type="button" onClick={() => go('/tasks/new')} className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-slate-50">
            <Zap className="mt-0.5 h-4 w-4 flex-none text-teal-600" aria-hidden="true" />
            <span><span className="block text-sm font-medium text-slate-900">New Task</span><span className="block text-xs text-slate-500">Do this now</span></span>
          </button>
          <button role="menuitem" type="button" onClick={() => go('/studio/new')} className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-slate-50">
            <ScrollText className="mt-0.5 h-4 w-4 flex-none text-teal-600" aria-hidden="true" />
            <span><span className="block text-sm font-medium text-slate-900">New Plan</span><span className="block text-xs text-slate-500">Work out and review what to do first</span></span>
          </button>
          <button role="menuitem" type="button" onClick={() => go('/goals?new=1')} className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-slate-50">
            <Target className="mt-0.5 h-4 w-4 flex-none text-indigo-600" aria-hidden="true" />
            <span><span className="block text-sm font-medium text-slate-900">New Goal</span><span className="block text-xs text-slate-500">Keep working toward an outcome</span></span>
          </button>
        </div>
      )}
    </div>
  );
};

const GlobalHeader: React.FC<GlobalHeaderProps> = ({ user, onLogout, onMenuToggle, MenuIcon, isDemoMode = false, headerStatsOverride, newPlanPressedOverride = false, inboxUnreadCount = null }) => {
  const desktop = useDesktop();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [searchRequest, setSearchRequest] = useState(0);

  const headerStats = useHeaderStats();
  const { activePlans, reviewGroups, systemHealth, dismissPlan, dismissTask, resourceStatuses } = resolveHeaderStats(headerStatsOverride, headerStats);

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

  return (
    <>
    {/* Global navigation owns app-wide dropdowns, so its stacking context must stay
        above route-level sticky headers such as task details summaries. */}
    <header aria-label="Application toolbar" className="desktop-content-toolbar sticky top-0 z-40 hidden h-14 grid-cols-[minmax(0,1fr)_16rem_minmax(0,1fr)] items-stretch border-b border-slate-200 bg-slate-50 md:grid xl:grid-cols-[minmax(0,1fr)_20rem_minmax(0,1fr)]">
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

      <div className="flex w-full items-center justify-center px-2">
        <div className="w-full">
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
        <NewWorkButton isDemoMode={isDemoMode} pressed={newPlanPressedOverride} />
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

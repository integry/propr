import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScrollText } from 'lucide-react';
import GlobalSearch from './GlobalSearch';
import AIActivityMonitor from './AIActivityMonitor';
import QuickAddTodo from './QuickAddTodo';
import { useHeaderStats, type HeaderStats } from '../hooks/useHeaderStats';
import {
  SystemHealth,
  ActivePlansButton,
  TasksButton,
} from './GlobalHeaderComponents';

interface GlobalHeaderProps {
  user: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
  } | null;
  onLogout: () => void;
  onMenuToggle: () => void;
  MenuIcon: React.FC<{ className?: string }>;
  isDemoMode?: boolean;
  headerStatsOverride?: Pick<HeaderStats, 'runningCount' | 'runningItems' | 'activePlans' | 'reviewGroups' | 'systemHealth'> & {
    dismissPlan?: HeaderStats['dismissPlan'];
    dismissTask?: HeaderStats['dismissTask'];
  };
  newPlanPressedOverride?: boolean;
}

function resolveHeaderStats(
  override: GlobalHeaderProps['headerStatsOverride'],
  stats: HeaderStats
) {
  return {
    runningCount: override?.runningCount ?? stats.runningCount,
    runningItems: override?.runningItems ?? stats.runningItems,
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

interface ProfileSectionProps {
  user: GlobalHeaderProps['user'];
  onLogout: () => void;
  systemHealth: HeaderStats['systemHealth'];
}

const ProfileSection: React.FC<ProfileSectionProps> = ({ user, onLogout, systemHealth }) => (
  <div className="flex items-center gap-2 px-4 relative">
    <div className="absolute left-0 top-[20%] h-[60%] w-px bg-slate-200" />
    <div className="hidden md:flex h-full">
      <SystemHealth systemHealth={systemHealth} />
    </div>
    {user && (
      <a
        href={`https://github.com/${user.username}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 hover:bg-slate-50 h-full px-2 transition-colors group"
      >
        <div className="hidden lg:flex flex-col items-end">
          <span className="text-sm font-semibold text-gray-700 group-hover:text-gray-900 transition-colors">
            {user.displayName || user.username}
          </span>
          <span className="text-xs text-gray-500 group-hover:text-gray-700 transition-colors">
            @{user.username}
          </span>
        </div>
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt={user.username}
            className="w-8 h-8 rounded-full border border-gray-200 group-hover:border-gray-300 transition-colors"
          />
        ) : (
          <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center text-primary-600 font-bold text-xs group-hover:bg-primary-200 transition-colors">
            {user.username.slice(0, 2).toUpperCase()}
          </div>
        )}
      </a>
    )}
    {user && (
      <button
        onClick={onLogout}
        className="text-sm text-gray-500 hover:text-red-600 font-medium transition-colors"
      >
        Logout
      </button>
    )}
  </div>
);

const GlobalHeader: React.FC<GlobalHeaderProps> = ({ user, onLogout, onMenuToggle, MenuIcon, isDemoMode = false, headerStatsOverride, newPlanPressedOverride = false }) => {
  const navigate = useNavigate();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  const headerStats = useHeaderStats();
  const { runningCount, runningItems, activePlans, reviewGroups, systemHealth, dismissPlan, dismissTask } = resolveHeaderStats(headerStatsOverride, headerStats);

  const handleNewPlan = useCallback(() => {
    if (isDemoMode) return;
    navigate('/studio/new');
  }, [isDemoMode, navigate]);

  useHeaderKeyboardShortcuts(searchInputRef, setQuickAddOpen);

  const newPlanBg = newPlanPressedOverride ? 'bg-teal-800' : 'bg-teal-600';
  const newPlanTitle = isDemoMode ? 'Demo mode is read-only' : 'New Plan';

  return (
    // Global navigation owns app-wide dropdowns, so its stacking context must stay
    // above route-level sticky headers such as task details summaries.
    <header className="bg-white border-b border-gray-200 h-12 sm:h-16 flex items-stretch shadow-sm z-40 sticky top-0">
      <div className="flex items-center lg:hidden px-4">
        <button
          onClick={onMenuToggle}
          className="p-2 -ml-2 text-gray-500 hover:text-gray-700"
          aria-label="Open menu"
        >
          <MenuIcon className="w-6 h-6" />
        </button>
      </div>

      {runningCount > 0 && (
        <div className="hidden sm:flex items-center relative">
          <AIActivityMonitor runningItems={runningItems} runningCount={runningCount} />
          <div className="absolute right-0 top-[20%] h-[60%] w-px bg-slate-200" />
        </div>
      )}

      <div className="hidden md:flex items-center relative">
        <ActivePlansButton activePlans={activePlans} onDismissPlan={dismissPlan} />
        <div className="absolute right-0 top-[20%] h-[60%] w-px bg-slate-200" />
      </div>

      <div className="hidden md:flex items-center relative">
        <TasksButton taskGroups={reviewGroups} onDismissTask={dismissTask} />
        <div className="absolute right-0 top-[20%] h-[60%] w-px bg-slate-200" />
      </div>

      <div className="flex-1 flex items-center justify-center px-2 sm:px-4">
        <div className="w-full max-w-md">
          <GlobalSearch inputRef={searchInputRef} />
        </div>
      </div>

      <div className="hidden md:flex items-center gap-2 px-4">
        <QuickAddTodo
          externalOpen={quickAddOpen}
          onExternalOpenHandled={() => setQuickAddOpen(false)}
          disabled={isDemoMode}
        />
        <button
          onClick={handleNewPlan}
          disabled={isDemoMode}
          title={newPlanTitle}
          className={`flex items-center gap-2 px-4 py-1.5 text-white text-sm font-medium hover:bg-teal-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed ${newPlanBg}`}
        >
          <ScrollText className="w-4 h-4" />
          <span>New Plan</span>
        </button>
      </div>

      <button
        onClick={handleNewPlan}
        disabled={isDemoMode}
        className={`md:hidden flex items-center px-4 text-white hover:bg-teal-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed ${newPlanBg}`}
        aria-label="New Plan"
        title={newPlanTitle}
      >
        <ScrollText className="w-5 h-5" />
      </button>

      <ProfileSection user={user} onLogout={onLogout} systemHealth={systemHealth} />
    </header>
  );
};

export default GlobalHeader;

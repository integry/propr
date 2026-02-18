import React, { useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScrollText } from 'lucide-react';
import GlobalSearch from './GlobalSearch';
import { useHeaderStats } from '../hooks/useHeaderStats';
import {
  MachineStatus,
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
}

// Main GlobalHeader Component
const GlobalHeader: React.FC<GlobalHeaderProps> = ({ user, onLogout, onMenuToggle, MenuIcon }) => {
  const navigate = useNavigate();
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Use the centralized header stats hook
  const {
    runningCount,
    activePlans,
    reviewGroups,
    systemHealth,
    dismissPlan,
    dismissTask,
  } = useHeaderStats();

  // Handle new plan navigation
  const handleNewPlan = useCallback(() => {
    navigate('/studio/new');
  }, [navigate]);

  // Keyboard shortcut for search (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <header className="bg-white border-b border-gray-200 h-16 flex items-stretch shadow-sm z-20 sticky top-0">
      {/* Left Section: Mobile Toggle + Machine Status (no border if empty) */}
      <div className="flex items-center lg:hidden px-4">
        {/* Mobile Toggle */}
        <button
          onClick={onMenuToggle}
          className="p-2 -ml-2 text-gray-500 hover:text-gray-700"
          aria-label="Open menu"
        >
          <MenuIcon className="w-6 h-6" />
        </button>
      </div>

      {/* Machine Status - Running agents indicator (only shows when there are running agents) */}
      {runningCount > 0 && (
        <div className="hidden sm:flex items-center px-3 relative">
          <MachineStatus runningCount={runningCount} />
          {/* Subtle divider at 60-70% height */}
          <div className="absolute right-0 top-[20%] h-[60%] w-px bg-slate-200" />
        </div>
      )}

      {/* Plans Bay - Full height partition, starts immediately after logo divider */}
      <div className="hidden md:flex items-center relative">
        <ActivePlansButton activePlans={activePlans} onDismissPlan={dismissPlan} />
        {/* Subtle divider at 60-70% height */}
        <div className="absolute right-0 top-[20%] h-[60%] w-px bg-slate-200" />
      </div>

      {/* Tasks Bay - Full height partition */}
      <div className="hidden md:flex items-center relative">
        <TasksButton taskGroups={reviewGroups} onDismissTask={dismissTask} />
        {/* Subtle divider at 60-70% height */}
        <div className="absolute right-0 top-[20%] h-[60%] w-px bg-slate-200" />
      </div>

      {/* Spacer - pushes everything to the right */}
      <div className="flex-1 flex items-center justify-center px-4">
        {/* Global Search - centered in the flexible space */}
        <div className="hidden md:block w-full max-w-md">
          <GlobalSearch inputRef={searchInputRef} />
        </div>
      </div>

      {/* New AI Plan Bay - Full height partition */}
      <div className="hidden md:flex items-center px-4 relative">
        {/* Subtle divider at 60-70% height */}
        <div className="absolute left-0 top-[20%] h-[60%] w-px bg-slate-200" />
        <button
          onClick={handleNewPlan}
          className="flex items-center gap-2 px-4 py-1.5 bg-teal-600 text-white text-sm font-medium hover:bg-teal-700 transition-colors"
        >
          <ScrollText className="w-4 h-4" />
          <span>New Plan</span>
        </button>
      </div>

      {/* Mobile New Plan Button */}
      <button
        onClick={handleNewPlan}
        className="md:hidden flex items-center px-4 relative bg-teal-600 text-white hover:bg-teal-700 transition-colors"
        aria-label="New Plan"
      >
        {/* Subtle divider at 60-70% height */}
        <div className="absolute left-0 top-[20%] h-[60%] w-px bg-slate-200" />
        <ScrollText className="w-5 h-5" />
      </button>

      {/* System/Profile Section */}
      <div className="flex items-center gap-2 px-4 relative">
        {/* Subtle divider at 60-70% height */}
        <div className="absolute left-0 top-[20%] h-[60%] w-px bg-slate-200" />
        {/* System Health */}
        <div className="hidden md:flex h-full">
          <SystemHealth systemHealth={systemHealth} />
        </div>

        {/* Profile */}
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

        {/* Logout */}
        {user && (
          <button
            onClick={onLogout}
            className="text-sm text-gray-500 hover:text-red-600 font-medium transition-colors"
          >
            Logout
          </button>
        )}
      </div>
    </header>
  );
};

export default GlobalHeader;

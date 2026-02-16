import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus } from 'lucide-react';
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
  const [searchQuery, setSearchQuery] = useState('');

  // Use the centralized header stats hook
  const {
    runningCount,
    activePlans,
    reviewGroups,
    systemHealth,
    dismissPlan,
    dismissTask,
  } = useHeaderStats();

  // Handle search submission
  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/tasks?search=${encodeURIComponent(searchQuery.trim())}`);
      setSearchQuery('');
    }
  }, [searchQuery, navigate]);

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
    <header className="bg-white border-b border-gray-200 h-16 flex items-center px-4 sm:px-8 shadow-sm z-20 sticky top-0">
      {/* Left Section: Mobile Toggle + Machine Status + Vertical Divider + Nav Blocks */}
      <div className="flex items-center gap-4">
        {/* Mobile Toggle */}
        <button
          onClick={onMenuToggle}
          className="lg:hidden p-2 -ml-2 text-gray-500 hover:text-gray-700"
          aria-label="Open menu"
        >
          <MenuIcon className="w-6 h-6" />
        </button>

        {/* Machine Status - Running agents indicator */}
        <div className="hidden sm:flex items-center">
          <MachineStatus runningCount={runningCount} />
        </div>

        {/* Nav Blocks: Plans + Divider + Tasks (Left-aligned after logo) */}
        <div className="hidden md:flex items-center gap-4">
          <ActivePlansButton activePlans={activePlans} onDismissPlan={dismissPlan} />
          {/* Vertical Divider - "Pipe" separator between Plans and Tasks */}
          <div className="w-px h-6 bg-gray-300" />
          <TasksButton taskGroups={reviewGroups} onDismissTask={dismissTask} />
        </div>
      </div>

      {/* Spacer - pushes everything to the right */}
      <div className="flex-1" />

      {/* Right Section: Search + New Plan + Status/Profile */}
      <div className="flex items-center gap-4">
        {/* Search Bar */}
        <form onSubmit={handleSearch} className="hidden md:block w-64">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search... [Cmd+K]"
              className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-slate-300 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 focus:bg-white transition-colors"
            />
          </div>
        </form>

        {/* Divider */}
        <div className="hidden md:block w-px h-6 bg-gray-200" />

        {/* Primary Action: New AI Plan */}
        <button
          onClick={handleNewPlan}
          className="hidden md:flex items-center gap-2 px-4 py-1.5 bg-teal-600 text-white text-sm font-medium hover:bg-teal-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>New AI Plan</span>
        </button>

        {/* Mobile New Plan Button */}
        <button
          onClick={handleNewPlan}
          className="md:hidden p-2 bg-teal-600 text-white hover:bg-teal-700 transition-colors"
          aria-label="New AI Plan"
        >
          <Plus className="w-5 h-5" />
        </button>

        {/* Divider */}
        <div className="hidden md:block w-px h-6 bg-gray-200" />

        {/* System/Profile Section */}
        <div className="flex items-center gap-2">
          {/* System Health */}
          <div className="hidden md:block">
            <SystemHealth systemHealth={systemHealth} />
          </div>

          {/* Profile */}
          {user && (
            <a
              href={`https://github.com/${user.username}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 hover:bg-slate-100 p-1 transition-colors group"
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
        </div>

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

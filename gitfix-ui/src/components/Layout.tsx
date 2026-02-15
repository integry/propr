import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ScrollText, ListTodo, BookMarked, Bot, Cpu, Search, Plus, Activity } from 'lucide-react';
import { getQueueStats, getCurrentUser, logout, getSystemStatus } from '../api/gitfixApi';
import { getGeneratingPlansCount } from '../api/taskStatsApi';
import { getRepositoriesIndexingStatus, RepositoryIndexingStatus } from '../api/repoIndexingApi';
import { useDynamicFavicon } from '../hooks/useDynamicFavicon';
import { useToast } from './ui/useToast';
import { HomeIcon, SettingsIcon, MenuIcon, CloseIcon } from './icons/LayoutIcons';

interface SystemStatusData {
  daemon: string;
  redis: string;
  githubAuth: string;
}

interface LayoutProps {
  children: React.ReactNode;
}

interface NavItem {
  name: string;
  href: string;
  icon: React.FC<{ className?: string }>;
}

interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [activeTaskCount, setActiveTaskCount] = useState<number>(0);
  const [generatingPlansCount, setGeneratingPlansCount] = useState<number>(0);
  const [user, setUser] = useState<User | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [systemStatus, setSystemStatus] = useState<SystemStatusData | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [isStatusTooltipOpen, setIsStatusTooltipOpen] = useState(false);
  const statusTooltipRef = useRef<HTMLDivElement>(null);
  // Track repository indexing statuses for toast notifications
  const repoStatusesRef = useRef<Map<string, string>>(new Map());

  // Update favicon to show combined count of tasks + plans
  // Note: activeTaskCount currently includes plans due to backend bug, which satisfies the requirement
  useDynamicFavicon(activeTaskCount);

  // Calculate display task count for sidebar by subtracting plans (clamped to 0)
  // This is a workaround for the backend including plan generation jobs in activeTaskCount
  const displayTaskCount = Math.max(0, activeTaskCount - generatingPlansCount);

  const navigation: NavItem[] = [
    { name: 'Dashboard', href: '/', icon: HomeIcon },
    { name: 'Plans', href: '/plans', icon: ScrollText },
    { name: 'Tasks', href: '/tasks', icon: ListTodo },
    { name: 'Repositories', href: '/repositories', icon: BookMarked },
    { name: 'Coding Agents', href: '/ai-agents', icon: Bot },
    { name: 'LLM Log', href: '/llm-logs', icon: Cpu },
    { name: 'Settings', href: '/settings', icon: SettingsIcon },
  ];

  const isActive = (path: string): boolean => {
    const currentPath = location.pathname;

    // Dashboard should only be active on exact match
    if (path === '/') {
      return currentPath === '/';
    }

    // Plans should be active for /plans routes and /studio routes
    if (path === '/plans') {
      return currentPath === '/plans' ||
             currentPath.startsWith('/plans/') ||
             currentPath.startsWith('/studio');
    }

    // Repositories should be active for /repositories routes and /summaries routes (repo content browsing)
    if (path === '/repositories') {
      return currentPath === '/repositories' ||
             currentPath.startsWith('/repositories/') ||
             currentPath.startsWith('/summaries');
    }

    // All other menu items use prefix matching
    return currentPath === path || currentPath.startsWith(path + '/');
  };

  // Close sidebar on route change (mobile)
  useEffect(() => {
    setIsSidebarOpen(false);
  }, [location]);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const data = await getQueueStats();
        setActiveTaskCount((data as { active?: number }).active || 0);
      } catch (err) {
        console.error('Error fetching queue stats for layout:', err);
        setActiveTaskCount(0);
      }
    };

    const fetchUser = async () => {
      try {
        const userData = await getCurrentUser();
        setUser(userData as User);
      } catch (err) {
        console.error('Error fetching user:', err);
      }
    };

    const fetchSystemStatus = async () => {
      try {
        const status = await getSystemStatus();
        setSystemStatus(status);
      } catch (err) {
        console.error('Error fetching system status:', err);
      }
    };

    const fetchGeneratingPlansCount = async () => {
      try {
        const data = await getGeneratingPlansCount();
        setGeneratingPlansCount(data.count || 0);
      } catch (err) {
        console.error('Error fetching generating plans count:', err);
        setGeneratingPlansCount(0);
      }
    };

    const fetchIndexingStatus = async () => {
      try {
        const data = await getRepositoriesIndexingStatus();
        const repositories = data.repositories || [];

        repositories.forEach((repo: RepositoryIndexingStatus) => {
          const previousStatus = repoStatusesRef.current.get(repo.full_name);
          const currentStatus = repo.indexing_status;

          // Show toast when transitioning from 'indexing' to 'failed'
          if (previousStatus === 'indexing' && currentStatus === 'failed') {
            addToast({
              type: 'error',
              message: `Indexing failed for ${repo.full_name}`,
            });
          }

          // Update the tracked status
          repoStatusesRef.current.set(repo.full_name, currentStatus);
        });
      } catch (err) {
        console.error('Error fetching repository indexing status:', err);
      }
    };

    fetchStats();
    fetchUser();
    fetchSystemStatus();
    fetchGeneratingPlansCount();
    fetchIndexingStatus();
    const interval = setInterval(() => {
      fetchStats();
      fetchSystemStatus();
      fetchGeneratingPlansCount();
      fetchIndexingStatus();
    }, 5000);
    return () => clearInterval(interval);
  }, [addToast]);

  // Helper for status color
  const getStatusColor = (status?: string): string => {
    if (!status) return 'bg-gray-400';
    const lowerStatus = status.toLowerCase();
    if (lowerStatus === 'running' || lowerStatus === 'connected' || lowerStatus === 'authenticated') {
      return 'bg-green-500';
    }
    return 'bg-red-500';
  };

  // Helper for overall system health color
  const getOverallHealthColor = (): string => {
    if (!systemStatus) return 'bg-gray-400';

    const statuses = [systemStatus.daemon, systemStatus.redis, systemStatus.githubAuth];
    const healthyStatuses = ['running', 'connected', 'authenticated'];

    const allHealthy = statuses.every(s => s && healthyStatuses.includes(s.toLowerCase()));
    const anyDown = statuses.some(s => s && !healthyStatuses.includes(s.toLowerCase()));

    if (allHealthy) return 'bg-green-500';
    if (anyDown) {
      // Check if critical (daemon down = red)
      if (systemStatus.daemon && !healthyStatuses.includes(systemStatus.daemon.toLowerCase())) {
        return 'bg-red-500';
      }
      return 'bg-amber-500';
    }
    return 'bg-gray-400';
  };

  // Close status tooltip when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (statusTooltipRef.current && !statusTooltipRef.current.contains(event.target as Node)) {
        setIsStatusTooltipOpen(false);
      }
    };

    if (isStatusTooltipOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isStatusTooltipOpen]);

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

  // Keyboard shortcut for search (⌘K / Ctrl+K)
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
    <div className="flex h-screen overflow-hidden bg-light-100 relative">
      {/* Mobile Overlay */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-gray-600 bg-opacity-75 z-20 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar - Responsive */}
      <aside className={`
        fixed lg:static inset-y-0 left-0 z-30
        w-60 bg-white border-r border-gray-200 shadow-sm
        transform transition-transform duration-200 ease-in-out
        ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        <div className="flex items-center justify-between px-4 py-6 h-16">
          <Link to="/" className="flex items-center">
            <img src="/media/logo-and-name.png" alt="ProPR" className="h-8 w-auto" />
          </Link>
          <button
            onClick={() => setIsSidebarOpen(false)}
            className="lg:hidden text-gray-500 hover:text-gray-700 p-1"
            aria-label="Close menu"
          >
            <CloseIcon className="w-6 h-6" />
          </button>
        </div>
        <nav className="flex flex-col gap-1 overflow-y-auto h-[calc(100%-4rem)]">
          {navigation.map((item) => (
            <Link
              key={item.name}
              to={item.href}
              className={`flex items-center px-4 py-3 text-sm font-medium transition-all duration-200 ${
                isActive(item.href)
                  ? 'bg-red-50 text-primary-600 border-r-2 border-primary-600 font-medium'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              <item.icon className="w-5 h-5 mr-3" />
              {item.name}
              {item.name === 'Tasks' && displayTaskCount > 0 && (
                <span className="ml-auto inline-flex items-center justify-center h-5 w-5 rounded-full bg-primary-500 text-xs font-semibold text-white">
                  {displayTaskCount}
                </span>
              )}
              {item.name === 'Plans' && generatingPlansCount > 0 && (
                <span className="ml-auto inline-flex items-center justify-center h-5 w-5 rounded-full bg-primary-500 text-xs font-semibold text-white">
                  {generatingPlansCount}
                </span>
              )}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Main content wrapper */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-gray-200 h-16 flex items-center justify-between px-4 sm:px-8 shadow-sm z-10 sticky top-0">
          {/* Mobile Toggle */}
          <button
            onClick={() => setIsSidebarOpen(true)}
            className="lg:hidden p-2 -ml-2 text-gray-500 hover:text-gray-700"
            aria-label="Open menu"
          >
            <MenuIcon className="w-6 h-6" />
          </button>

          {/* Spacer to push action cluster to the right */}
          <div className="flex-1" />

          {/* Action Cluster - Right-aligned: Search → New Plan | Status → Profile */}
          <div className="flex items-center gap-3">
            {/* Zone A: Tools (Search + Create) */}
            {/* Compact Search Bar - 300px width */}
            <form onSubmit={handleSearch} className="hidden md:block w-[300px]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search... [⌘K]"
                  className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 focus:bg-white transition-colors"
                />
              </div>
            </form>

            {/* New Plan Button - Primary Action */}
            <button
              onClick={handleNewPlan}
              className="hidden sm:flex items-center gap-2 px-4 py-2 bg-teal-600 text-white text-sm font-medium rounded-lg hover:bg-teal-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>New AI Plan</span>
            </button>

            {/* Mobile New Plan Button - Icon only */}
            <button
              onClick={handleNewPlan}
              className="sm:hidden p-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors"
              aria-label="New AI Plan"
            >
              <Plus className="w-5 h-5" />
            </button>

            {/* Vertical Divider - Separates Tools from Context */}
            <div className="hidden md:block h-6 w-px bg-gray-300"></div>

            {/* Zone B: Context (Status + Profile) */}
            {/* System Health Pulse Icon with Dropdown */}
            <div className="hidden md:block relative" ref={statusTooltipRef}>
              <button
                onClick={() => setIsStatusTooltipOpen(!isStatusTooltipOpen)}
                onMouseEnter={() => setIsStatusTooltipOpen(true)}
                className="flex items-center gap-1.5 p-2 rounded-lg hover:bg-gray-100 transition-colors"
                aria-label="System Status"
              >
                <Activity className="w-4 h-4 text-gray-500" />
                <span className={`w-2 h-2 rounded-full ${getOverallHealthColor()}`} />
              </button>

              {/* Status Dropdown Tooltip */}
              {isStatusTooltipOpen && (
                <div
                  className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-2 px-3 min-w-[160px] z-50"
                  onMouseLeave={() => setIsStatusTooltipOpen(false)}
                >
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">System Status</div>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-sm text-gray-700">
                      <span className={`w-2 h-2 rounded-full ${getStatusColor(systemStatus?.daemon)}`} />
                      <span>Daemon:</span>
                      <span className="ml-auto font-medium">{systemStatus?.daemon || 'Unknown'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-gray-700">
                      <span className={`w-2 h-2 rounded-full ${getStatusColor(systemStatus?.redis)}`} />
                      <span>Redis:</span>
                      <span className="ml-auto font-medium">{systemStatus?.redis || 'Unknown'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-gray-700">
                      <span className={`w-2 h-2 rounded-full ${getStatusColor(systemStatus?.githubAuth)}`} />
                      <span>GitHub:</span>
                      <span className="ml-auto font-medium">{systemStatus?.githubAuth || 'Unknown'}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Profile */}
            {user && (
              <a
                href={`https://github.com/${user.username}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 hover:bg-gray-50 rounded-lg p-1 transition-colors group"
              >
                <div className="hidden lg:flex flex-col items-end">
                  <span className="text-sm font-semibold text-gray-700 group-hover:text-gray-900 transition-colors">
                    {user.displayName || user.username}
                  </span>
                  <span className="text-xs text-gray-500 group-hover:text-gray-700 transition-colors">@{user.username}</span>
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
                onClick={logout}
                className="text-sm text-gray-500 hover:text-red-600 font-medium transition-colors"
              >
                Logout
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
};

export default Layout;

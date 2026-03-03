import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ScrollText, ListTodo, BookMarked, Bot, Cpu } from 'lucide-react';
import { getQueueStats, getCurrentUser, logout } from '../api/proprApi';
import { getGeneratingPlansCount } from '../api/taskStatsApi';
import { getRepositoriesIndexingStatus, RepositoryIndexingStatus } from '../api/repoIndexingApi';
import { useDynamicFavicon } from '../hooks/useDynamicFavicon';
import { useSystemReadiness } from '../hooks/useSystemReadiness';
import { useToast } from './ui/useToast';
import { HomeIcon, SettingsIcon, MenuIcon, CloseIcon } from './icons/LayoutIcons';
import GlobalHeader from './GlobalHeader';

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
  const { addToast } = useToast();
  const [activeTaskCount, setActiveTaskCount] = useState<number>(0);
  const [generatingPlansCount, setGeneratingPlansCount] = useState<number>(0);
  const [user, setUser] = useState<User | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  // Track repository indexing statuses for toast notifications
  const repoStatusesRef = useRef<Map<string, string>>(new Map());

  // Update favicon to show combined count of tasks + plans
  // Note: activeTaskCount currently includes plans due to backend bug, which satisfies the requirement
  useDynamicFavicon(activeTaskCount);

  // Track system readiness for proactive sidebar indicators
  const { hasAgents, hasRepos } = useSystemReadiness();

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
    fetchGeneratingPlansCount();
    fetchIndexingStatus();
    const interval = setInterval(() => {
      fetchStats();
      fetchGeneratingPlansCount();
      fetchIndexingStatus();
    }, 5000);
    return () => clearInterval(interval);
  }, [addToast]);

  // Handler for menu toggle
  const handleMenuToggle = () => {
    setIsSidebarOpen(true);
  };

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
              className={`flex items-center px-4 py-3 text-sm font-medium transition-all duration-200 border-r-2 ${
                isActive(item.href)
                  ? 'bg-red-50 text-primary-600 border-primary-600 font-medium'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 border-transparent'
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
              {item.name === 'Repositories' && !hasRepos && (
                <span className="ml-auto w-2 h-2 rounded-full bg-amber-500" title="No repositories configured" />
              )}
              {item.name === 'Coding Agents' && !hasAgents && (
                <span className="ml-auto w-2 h-2 rounded-full bg-amber-500" title="No AI agents configured" />
              )}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Main content wrapper */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* GlobalHeader replaces the old inline header */}
        <GlobalHeader
          user={user}
          onLogout={logout}
          onMenuToggle={handleMenuToggle}
          MenuIcon={MenuIcon}
        />

        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
};

export default Layout;

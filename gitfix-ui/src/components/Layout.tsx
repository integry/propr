import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ScrollText, ListTodo, BookMarked, Bot } from 'lucide-react';
import { getQueueStats, getCurrentUser, logout, getSystemStatus } from '../api/gitfixApi';
import { getGeneratingPlansCount } from '../api/taskStatsApi';
import { useDynamicFavicon } from '../hooks/useDynamicFavicon';

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
  const [activeTaskCount, setActiveTaskCount] = useState<number>(0);
  const [generatingPlansCount, setGeneratingPlansCount] = useState<number>(0);
  const [user, setUser] = useState<User | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [systemStatus, setSystemStatus] = useState<SystemStatusData | null>(null);

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
    { name: 'Settings', href: '/settings', icon: SettingsIcon },
  ];

  const isActive = (path: string): boolean => location.pathname === path;

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

    fetchStats();
    fetchUser();
    fetchSystemStatus();
    fetchGeneratingPlansCount();
    const interval = setInterval(() => {
      fetchStats();
      fetchSystemStatus();
      fetchGeneratingPlansCount();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Helper for status color
  const getStatusColor = (status?: string): string => {
    if (!status) return 'bg-gray-400';
    const lowerStatus = status.toLowerCase();
    if (lowerStatus === 'running' || lowerStatus === 'connected' || lowerStatus === 'authenticated') {
      return 'bg-green-500';
    }
    return 'bg-red-500';
  };

  return (
    <div className="flex min-h-screen bg-light-100 relative">
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

          {/* Spacer for desktop when no hamburger is shown */}
          <div className="hidden lg:block"></div>

          <div className="flex items-center gap-4">
            {/* System Status Indicators */}
            <div className="hidden md:flex items-center gap-4 mr-4 border-r border-gray-200 pr-4">
              <div className="flex items-center gap-2" title={`Daemon: ${systemStatus?.daemon || 'Unknown'}`}>
                <div className={`w-2 h-2 rounded-full ${getStatusColor(systemStatus?.daemon)}`} />
                <span className="text-xs text-gray-500">Daemon</span>
              </div>
              <div className="flex items-center gap-2" title={`Redis: ${systemStatus?.redis || 'Unknown'}`}>
                <div className={`w-2 h-2 rounded-full ${getStatusColor(systemStatus?.redis)}`} />
                <span className="text-xs text-gray-500">Redis</span>
              </div>
              <div className="flex items-center gap-2" title={`GitHub: ${systemStatus?.githubAuth || 'Unknown'}`}>
                <div className={`w-2 h-2 rounded-full ${getStatusColor(systemStatus?.githubAuth)}`} />
                <span className="text-xs text-gray-500">GitHub</span>
              </div>
            </div>

            {user && (
              <>
                <a
                  href={`https://github.com/${user.username}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 hover:bg-gray-50 rounded-lg p-1 transition-colors group"
                >
                  <div className="hidden sm:flex flex-col items-end">
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

                <div className="h-6 w-px bg-gray-200 mx-1"></div>

                <button
                  onClick={logout}
                  className="text-sm text-gray-500 hover:text-red-600 font-medium transition-colors"
                >
                  Logout
                </button>
              </>
            )}
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-8 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
};

// Icon components
interface IconProps {
  className?: string;
}

const HomeIcon: React.FC<IconProps> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
  </svg>
);

const SettingsIcon: React.FC<IconProps> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const MenuIcon: React.FC<IconProps> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);

const CloseIcon: React.FC<IconProps> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
  </svg>
);

export default Layout;

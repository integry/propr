import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  BookMarked,
  Bot,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleAlert,
  Cpu,
  Home,
  Inbox,
  LogOut,
  MoreHorizontal,
  ScrollText,
  Settings,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { HeaderStats } from '../hooks/useHeaderStats';
import type { CurrentUser } from '../api/proprTypes';
import { userHasPermission } from '../contexts/AuthContext';

interface MobileBottomNavigationProps {
  user: CurrentUser | null;
  onLogout: () => void;
  isDemoMode: boolean;
  unreadCount: number | null;
  systemHealth: HeaderStats['systemHealth'];
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'details > summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const pathMatches = (pathname: string, path: string): boolean =>
  pathname === path || pathname.startsWith(`${path}/`);

const getNavigationState = (pathname: string) => {
  const newPlan = pathname === '/studio/new';
  return {
    inbox: pathMatches(pathname, '/inbox'),
    activity: pathMatches(pathname, '/tasks'),
    newPlan,
    repositories: pathMatches(pathname, '/repositories') || pathMatches(pathname, '/summaries'),
    more: pathname === '/' || pathMatches(pathname, '/plans') ||
      (pathMatches(pathname, '/studio') && !newPlan) ||
      pathMatches(pathname, '/ai-agents') || pathMatches(pathname, '/llm-logs') ||
      pathMatches(pathname, '/settings') || pathMatches(pathname, '/admin/members'),
  };
};

const getMoreItems = (user: CurrentUser | null) => [
  { label: 'Dashboard', to: '/', icon: Home },
  { label: 'Plans', to: '/plans', icon: ScrollText },
  ...(userHasPermission(user, 'instance.manage_agents')
    ? [{ label: 'Coding Agents', to: '/ai-agents', icon: Bot }]
    : []),
  { label: 'Logs', to: '/llm-logs', icon: Cpu },
  { label: 'Settings', to: '/settings', icon: Settings },
  ...(userHasPermission(user, 'instance.manage_members')
    ? [{ label: 'Access', to: '/admin/members', icon: ShieldCheck }]
    : []),
];

interface MobileNavLinkProps {
  to: string;
  label: string;
  active: boolean;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  accessibleLabel?: string;
  onClick?: () => void;
}

const MobileNavLink: React.FC<MobileNavLinkProps> = ({
  to,
  label,
  active,
  icon,
  badge,
  accessibleLabel,
  onClick,
}) => (
  <Link
    to={to}
    onClick={onClick}
    aria-label={accessibleLabel}
    aria-current={active ? 'page' : undefined}
    className={`relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 ${
      active ? 'text-primary-700' : 'text-slate-500 hover:text-slate-800'
    }`}
  >
    <span className="relative">
      {icon}
      {badge}
    </span>
    <span className="truncate">{label}</span>
  </Link>
);

const HealthDetails: React.FC<{ systemHealth: HeaderStats['systemHealth'] }> = ({ systemHealth }) => {
  const rows = [
    ['Daemon', systemHealth.daemon],
    ['Workers', systemHealth.workers],
    ['Redis', systemHealth.redis],
    ['GitHub', systemHealth.githubAuth],
    ['Indexing', systemHealth.indexing],
  ];

  return (
    <details className="group border-t border-slate-100">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden">
        {systemHealth.isHealthy ? (
          <CircleCheck className="h-5 w-5 flex-none text-green-600" aria-hidden="true" />
        ) : (
          <CircleAlert className="h-5 w-5 flex-none text-amber-600" aria-hidden="true" />
        )}
        <span className="font-medium">System health</span>
        <span className={`ml-auto text-xs font-medium ${systemHealth.isHealthy ? 'text-green-700' : 'text-amber-700'}`}>
          {systemHealth.isHealthy ? 'Healthy' : 'Needs attention'}
        </span>
        <ChevronDown className="h-4 w-4 text-slate-400 group-open:hidden" aria-hidden="true" />
        <ChevronUp className="hidden h-4 w-4 text-slate-400 group-open:block" aria-hidden="true" />
      </summary>
      <div className="space-y-2 bg-slate-50 px-4 py-3">
        {rows.map(([label, status]) => (
          <div key={label} className="flex items-center justify-between gap-4 text-xs">
            <span className="text-slate-500">{label}</span>
            <span className="font-medium text-slate-700">{status}</span>
          </div>
        ))}
      </div>
    </details>
  );
};

const MobileBottomNavigation: React.FC<MobileBottomNavigationProps> = ({
  user,
  onLogout,
  isDemoMode,
  unreadCount,
  systemHealth,
}) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const closeMore = useCallback((restoreFocus = true) => {
    setIsMoreOpen(false);
    if (restoreFocus) moreButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    setIsMoreOpen(false);
  }, [location.pathname, location.search, location.hash]);

  useEffect(() => {
    if (!isMoreOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const firstFocusable = sheetRef.current?.querySelector<HTMLElement>(focusableSelector);
    firstFocusable?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMore();
        return;
      }
      if (event.key !== 'Tab' || !sheetRef.current) return;

      const focusable = Array.from(sheetRef.current.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) {
        event.preventDefault();
        sheetRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeMore, isMoreOpen]);

  const active = getNavigationState(location.pathname);

  const unreadBadge = unreadCount !== null && unreadCount > 0 ? (
    <span className="absolute -right-2.5 -top-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary-500 px-1 text-[9px] font-bold leading-4 text-white">
      {unreadCount > 99 ? '99+' : unreadCount}
    </span>
  ) : undefined;

  const moreItems = getMoreItems(user);

  return (
    <>
      {isMoreOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            data-testid="mobile-more-backdrop"
            className="absolute inset-0 h-full w-full cursor-default bg-slate-950/45"
            onClick={() => closeMore()}
            aria-hidden="true"
          />
          <div
            ref={sheetRef}
            id="mobile-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-more-title"
            tabIndex={-1}
            className="absolute inset-x-0 bottom-0 max-h-[min(80vh,38rem)] overflow-y-auto rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl"
          >
            <div className="sticky top-0 flex items-center border-b border-slate-200 bg-white px-4 py-3">
              <h2 id="mobile-more-title" className="text-base font-semibold text-slate-900">More</h2>
              <button
                type="button"
                onClick={() => closeMore()}
                className="ml-auto rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                aria-label="Close More menu"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <nav aria-label="More navigation" className="grid grid-cols-2 gap-2 p-3">
              {moreItems.map(item => (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => closeMore(false)}
                  className="flex min-h-12 items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                >
                  <item.icon className="h-5 w-5 text-slate-500" aria-hidden="true" />
                  {item.label}
                </Link>
              ))}
            </nav>

            <HealthDetails systemHealth={systemHealth} />

            {user && (
              <div className="border-t border-slate-100 p-4">
                <div className="flex items-center gap-3">
                  {user.avatarUrl ? (
                    <img src={user.avatarUrl} alt="" className="h-10 w-10 rounded-full border border-slate-200" />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-100 text-xs font-bold text-primary-700" aria-hidden="true">
                      {user.username.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-800">{user.displayName || user.username}</p>
                    <p className="truncate text-xs text-slate-500">@{user.username}</p>
                  </div>
                  <button
                    type="button"
                    onClick={onLogout}
                    className="inline-flex min-h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                    Sign out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <nav
        aria-label="Primary navigation"
        className="mobile-bottom-navigation fixed inset-x-0 bottom-0 z-40 flex h-[calc(4rem+env(safe-area-inset-bottom))] border-t border-slate-200 bg-white/95 shadow-[0_-4px_16px_rgba(15,23,42,0.08)] backdrop-blur md:hidden"
      >
        <MobileNavLink
          to="/inbox"
          label="Inbox"
          active={active.inbox}
          accessibleLabel={unreadCount !== null && unreadCount > 0
            ? `Inbox, ${unreadCount} unread notifications`
            : 'Inbox'}
          icon={<Inbox className="h-5 w-5" aria-hidden="true" />}
          badge={unreadBadge}
        />
        <MobileNavLink
          to="/tasks"
          label="Activity"
          active={active.activity}
          icon={<Activity className="h-5 w-5" aria-hidden="true" />}
        />
        <button
          type="button"
          onClick={() => {
            if (!isDemoMode) navigate('/studio/new');
          }}
          disabled={isDemoMode}
          aria-current={active.newPlan ? 'page' : undefined}
          aria-label={isDemoMode ? 'New Plan unavailable in demo mode' : 'New Plan'}
          className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 disabled:text-slate-400 ${
            active.newPlan ? 'text-primary-800' : 'text-primary-700'
          }`}
        >
          <span className={`flex h-8 w-9 items-center justify-center rounded-lg ${isDemoMode ? 'bg-slate-200' : 'bg-primary-600 text-white shadow-sm'}`}>
            <ScrollText className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="truncate">New Plan</span>
        </button>
        <MobileNavLink
          to="/repositories"
          label="Repositories"
          active={active.repositories}
          icon={<BookMarked className="h-5 w-5" aria-hidden="true" />}
        />
        <button
          ref={moreButtonRef}
          type="button"
          onClick={() => setIsMoreOpen(open => !open)}
          aria-expanded={isMoreOpen}
          aria-controls="mobile-more-sheet"
          aria-current={active.more ? 'page' : undefined}
          className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 ${
            active.more || isMoreOpen ? 'text-primary-700' : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
          <span>More</span>
        </button>
      </nav>
    </>
  );
};

export default MobileBottomNavigation;

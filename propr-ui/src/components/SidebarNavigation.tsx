import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  LayoutDashboard, ScrollText, ListTodo, BookMarked, Bot, ChartColumn, ChevronDown, ChevronRight,
  Cpu, Logs, Plug, Puzzle, Settings, ShieldCheck, Inbox, Target, TriangleAlert, Workflow,
} from 'lucide-react';
import { SIDEBAR_ICON_STROKE_WIDTH, SIDEBAR_ICON_STROKE_CLASS } from './icons/sidebarIconStroke';

/**
 * The sidebar's navigation model and rendering: its two zones, the badges and
 * readiness indicators on a row, and the collapsible groups that hold related
 * destinations together.
 */

type NavIcon = React.FC<{ className?: string; strokeWidth?: number | string }>;

interface NavItem {
  name: string;
  href: string;
  // All nav icons come from lucide so a shared strokeWidth keeps line weights uniform.
  icon: NavIcon;
}

/** A collapsible set of related destinations, drawn like the items it contains. */
interface NavGroup {
  name: string;
  icon: NavIcon;
  items: NavItem[];
}

type NavEntry = NavItem | NavGroup;

function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'items' in entry;
}

export interface NavigationState {
  currentPath: string;
  desktop: boolean;
  hasAgents: boolean;
  hasRepos: boolean;
  hasTasks: boolean;
  taskCount: number;
  goalCount: number;
  generatingPlansCount: number;
  unreadCount: number | null;
}

const CORE_NAVIGATION: NavItem[] = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Inbox', href: '/inbox', icon: Inbox },
  { name: 'Tasks', href: '/tasks', icon: ListTodo },
  { name: 'Goals', href: '/goals', icon: Target },
  { name: 'Automations', href: '/automations', icon: Workflow },
  { name: 'Plans', href: '/plans', icon: ScrollText },
];

function getResourceNavigation(
  canManageAgents: boolean,
  canManageMembers: boolean,
  canReadMcpLog: boolean,
  canManagePlugins = false,
): NavEntry[] {
  const navigation: NavEntry[] = [{ name: 'Repositories', href: '/repositories', icon: BookMarked }];
  if (canManageAgents) navigation.push({ name: 'Coding agents', href: '/ai-agents', icon: Bot });
  const logs: NavItem[] = [{ name: 'LLM Log', href: '/llm-logs', icon: Cpu }];
  // The MCP access log is readable only by operators who may manage the
  // instance — the same permission /api/admin/mcp/logs itself requires.
  if (canReadMcpLog) logs.push({ name: 'MCP Log', href: '/mcp-logs', icon: Plug });
  navigation.push(
    { name: 'Analytics', href: '/analytics', icon: ChartColumn },
    { name: 'Logs', icon: Logs, items: logs },
    { name: 'Settings', href: '/settings', icon: Settings },
  );
  // Plugins need a durable administrator who may change instance settings, as their API does.
  if (canManagePlugins) navigation.push({ name: 'Plugins', href: '/plugins', icon: Puzzle });
  if (canManageMembers) navigation.push({ name: 'Access', href: '/admin/members', icon: ShieldCheck });
  return navigation;
}

function isNavigationItemActive(currentPath: string, itemPath: string): boolean {
  // Dashboard should only be active on exact match.
  if (itemPath === '/') return currentPath === '/';

  // Plans also owns studio routes.
  if (itemPath === '/plans') {
    return currentPath === '/plans' || currentPath.startsWith('/plans/') || currentPath.startsWith('/studio');
  }

  // Repository content browsing includes summaries routes.
  if (itemPath === '/repositories') {
    return currentPath === '/repositories' || currentPath.startsWith('/repositories/') || currentPath.startsWith('/summaries');
  }

  return currentPath === itemPath || currentPath.startsWith(itemPath + '/');
}

// Single badge component for all nav counts: forms a circle for one digit and
// stretches horizontally for wider content (e.g. "99+") with the same radius and padding.
// The parent nav row is `flex items-center justify-between`, which keeps the badge on
// the same horizontal center line as the label.
//
// The digits are centered by the flex box alone: `leading-none` collapses the line
// box onto the glyphs (digits have no descender, so their ink already centers on the
// em box), and no vertical nudge is applied on top of it — a nudge is what made the
// numbers sit low in the pill.
function NavBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-4 min-w-4 flex-none items-center justify-center rounded-full bg-primary-500 px-1 text-[10px] font-bold leading-none text-white">
      {children}
    </span>
  );
}

function WorkCountBadge({ name, taskCount, goalCount }: { name: string; taskCount: number; goalCount: number }) {
  const count = name === 'Tasks' ? taskCount : name === 'Goals' ? goalCount : 0;
  if (count <= 0) return null;
  return <NavBadge>{count}</NavBadge>;
}

function getReadinessMessage(name: string, state: NavigationState): string | null {
  if (name === 'Repositories' && !state.hasRepos) return 'No repositories configured';
  if (name === 'Coding agents' && !state.hasAgents) return 'No coding agents configured';
  if (name === 'Tasks' && state.taskCount === 0 && !state.hasTasks && state.hasAgents && state.hasRepos) {
    return 'No tasks created yet';
  }
  return null;
}

function ReadinessIndicator({ message, desktop }: { message: string | null; desktop: boolean }) {
  if (!message) return null;
  if (!desktop) return <span className="w-2 h-2 flex-none rounded-full bg-amber-500" title={message} />;
  return (
    <span className="flex h-4 w-4 flex-none items-center justify-center text-amber-600" role="img" aria-label={message} title={message}>
      <TriangleAlert className={`${SIDEBAR_ICON_STROKE_CLASS} h-3.5 w-3.5`} strokeWidth={SIDEBAR_ICON_STROKE_WIDTH} aria-hidden="true" />
    </span>
  );
}

function InboxBadge({ name, unreadCount }: { name: string; unreadCount: number | null }) {
  if (name !== 'Inbox' || unreadCount === null || unreadCount <= 0) return null;
  return <NavBadge>{unreadCount > 99 ? '99+' : unreadCount}</NavBadge>;
}

function PlansBadge({ name, count }: { name: string; count: number }) {
  if (name !== 'Plans' || count <= 0) return null;
  return <NavBadge>{count}</NavBadge>;
}

/**
 * How much shorter each row is while Usage is folded: 2px less padding above and
 * below. Folding must free room for every item in a 720px window, and expanding
 * again budgets for the rows growing back (see useSidebarUsageFit).
 */
export const SIDEBAR_DENSE_ROW_SAVING_PX = 4;
/** Marks each navigation row, so the fit measurement can count them. */
export const SIDEBAR_ROW_ATTRIBUTE = 'data-sidebar-row';
const rowAttribute = { [SIDEBAR_ROW_ATTRIBUTE]: '' };

function getNavigationItemClassName(desktop: boolean, active: boolean, dense: boolean): string {
  const dimensions = desktop
    ? `mx-2 rounded-[6px] border-0 px-2 ${dense ? 'py-1' : 'py-1.5'} tracking-tight`
    : `border-l-4 px-4 ${dense ? 'py-1.5' : 'py-2'}`;
  if (active) {
    return `${dimensions} ${desktop
      ? 'bg-black/5 font-normal text-slate-900'
      : 'bg-slate-50 font-medium text-slate-900 border-primary-600'}`;
  }
  return `${dimensions} ${desktop
    ? 'font-normal text-slate-600 hover:bg-slate-900/5 hover:text-slate-900'
    : 'font-normal text-gray-600 hover:bg-gray-50 hover:text-gray-900 border-transparent'}`;
}

function NavigationItem({ item, state, dense, nested = false }: { item: NavItem; state: NavigationState; dense: boolean; nested?: boolean }) {
  const readinessMessage = getReadinessMessage(item.name, state);
  const active = isNavigationItemActive(state.currentPath, item.href);
  return (
    <Link
      to={item.href}
      {...rowAttribute}
      className={`flex items-center justify-between text-[13px] leading-5 transition-colors duration-150 ${getNavigationItemClassName(state.desktop, active, dense)}`}
    >
      {/* A group's children indent their label, not their row: the active and
          hover ink keeps the same full-width shape as every other nav item. */}
      <span className={`flex min-w-0 items-center${nested ? ' pl-4' : ''}`}>
        <item.icon className={`${SIDEBAR_ICON_STROKE_CLASS} mr-2.5 h-4 w-4 flex-none`} strokeWidth={SIDEBAR_ICON_STROKE_WIDTH} />
        <span className="truncate">{item.name}</span>
      </span>
      {/* Counts and readiness indicators share the trailing rail. */}
      <span className="flex flex-none items-center justify-end gap-1.5">
        <ReadinessIndicator message={readinessMessage} desktop={state.desktop} />
        <WorkCountBadge name={item.name} taskCount={state.taskCount} goalCount={state.goalCount} />
        <InboxBadge name={item.name} unreadCount={state.unreadCount} />
        <PlansBadge name={item.name} count={state.generatingPlansCount} />
      </span>
    </Link>
  );
}

// Sidebar group expansion is a per-session preference: it survives navigation
// and reload within the tab, and starts fresh in the next one.
const NAV_GROUP_STORAGE_KEY = 'propr.sidebar.nav-groups';

function readNavGroupState(): Record<string, boolean> {
  try {
    const stored = window.sessionStorage.getItem(NAV_GROUP_STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, boolean> : {};
  } catch {
    return {};
  }
}

function storeNavGroupState(name: string, expanded: boolean): void {
  try {
    window.sessionStorage.setItem(NAV_GROUP_STORAGE_KEY, JSON.stringify({ ...readNavGroupState(), [name]: expanded }));
  } catch {
    // A sidebar preference is never worth failing navigation over.
  }
}

function navGroupPanelId(name: string): string {
  return `sidebar-nav-group-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function NavigationGroup({ group, state, dense }: { group: NavGroup; state: NavigationState; dense: boolean }) {
  const childActive = group.items.some(item => isNavigationItemActive(state.currentPath, item.href));
  const [expanded, setExpanded] = useState(() => {
    const stored = readNavGroupState()[group.name];
    return typeof stored === 'boolean' ? stored : childActive;
  });
  const wasChildActive = useRef(childActive);

  useEffect(() => {
    // Navigating into the group opens it, so a child page is never hidden.
    // A group collapsed while already inside it stays collapsed.
    if (childActive && !wasChildActive.current) setExpanded(true);
    wasChildActive.current = childActive;
  }, [childActive]);

  const toggle = useCallback(() => {
    setExpanded(current => {
      storeNavGroupState(group.name, !current);
      return !current;
    });
  }, [group.name]);

  const panelId = navGroupPanelId(group.name);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        {...rowAttribute}
        // The header carries the active treatment of its children, so a
        // collapsed group still shows that the current page is inside it.
        // Like the links, it takes its width from the column's stretch: a
        // w-full here would add the desktop mx-2 inset to the full scrollport
        // width and overflow the navigation horizontally.
        className={`flex items-center justify-between text-left text-[13px] leading-5 transition-colors duration-150 ${getNavigationItemClassName(state.desktop, childActive, dense)}`}
      >
        <span className="flex min-w-0 items-center">
          <group.icon className={`${SIDEBAR_ICON_STROKE_CLASS} mr-2.5 h-4 w-4 flex-none`} strokeWidth={SIDEBAR_ICON_STROKE_WIDTH} aria-hidden="true" />
          <span className="truncate">{group.name}</span>
        </span>
        <Chevron
          className={`${SIDEBAR_ICON_STROKE_CLASS} h-3.5 w-3.5 flex-none text-slate-400`}
          strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
          aria-hidden="true"
        />
      </button>
      {/* The panel keeps its id for aria-controls in both states. Its children
          are dropped rather than only marked hidden: a Tailwind display utility
          on the container would otherwise win over the [hidden] UA rule. */}
      <div id={panelId} hidden={!expanded} className="flex flex-col gap-0.5">
        {expanded && group.items.map(item => <NavigationItem key={item.name} item={item} state={state} dense={dense} nested />)}
      </div>
    </div>
  );
}

function NavigationEntry({ entry, state, dense }: { entry: NavEntry; state: NavigationState; dense: boolean }) {
  return isNavGroup(entry)
    ? <NavigationGroup group={entry} state={state} dense={dense} />
    : <NavigationItem item={entry} state={state} dense={dense} />;
}

/** Whether a scroller has content below its visible part, kept current on scroll and resize. */
function useScrollableBelow() {
  const [below, setBelow] = useState(false);
  const elementRef = useRef<HTMLElement | null>(null);
  const update = useCallback(() => {
    const element = elementRef.current;
    setBelow(Boolean(element && element.scrollTop + element.clientHeight < element.scrollHeight - 1));
  }, []);
  const observerRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    elementRef.current = element;
    if (!element) return;
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    observerRef.current = observer;
  }, [update]);
  return useMemo(() => ({ below, ref, update }), [below, ref, update]);
}

/**
 * The sidebar's two navigation zones: the core workflow, then the technical
 * resources. They are separated by whitespace — never a divider line.
 */
export function SidebarNavigation({ state, permissions, navRef, dense = false }: {
  state: NavigationState;
  permissions: { canManageAgents: boolean; canManageMembers: boolean; canReadMcpLog: boolean; canManagePlugins?: boolean };
  /** The scroller, for the sidebar to measure whether every item fits. */
  navRef?: (element: HTMLElement | null) => void;
  /** Tighter rows, while Usage is folded to make room in a short window. */
  dense?: boolean;
}) {
  const resources = getResourceNavigation(
    permissions.canManageAgents,
    permissions.canManageMembers,
    permissions.canReadMcpLog,
    permissions.canManagePlugins,
  );
  const { below: scrollableBelow, ref: scrollRef, update: updateScroll } = useScrollableBelow();
  const setNav = useCallback((element: HTMLElement | null) => {
    scrollRef(element);
    navRef?.(element);
  }, [navRef, scrollRef]);
  return (
    // When the window is too short for every item, the list scrolls with a
    // visible thin scrollbar and a fade over the last visible row, so the
    // items below are evidently there rather than hidden under Usage.
    <nav ref={setNav} onScroll={updateScroll} data-scrollable-below={scrollableBelow || undefined}
      className="scrollbar-thin relative flex min-h-0 flex-col overflow-y-auto pt-2 pb-1">
      <div className="flex flex-col gap-0.5">
        {CORE_NAVIGATION.map(item => <NavigationItem key={item.name} item={item} state={state} dense={dense} />)}
      </div>
      {/* Whitespace spacer (no divider) between the core-workflow and
          technical-resources zones. */}
      <div className="mt-6 flex flex-col gap-0.5">
        {resources.map(entry => <NavigationEntry key={entry.name} entry={entry} state={state} dense={dense} />)}
      </div>
      {scrollableBelow && !state.desktop && (
        <div aria-hidden="true" data-testid="sidebar-nav-fade"
          className="pointer-events-none sticky bottom-0 -mt-8 h-8 flex-none bg-gradient-to-t from-white to-transparent" />
      )}
    </nav>
  );
}

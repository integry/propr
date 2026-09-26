import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Zap } from 'lucide-react';
import { DESKTOP_UI_COMMAND_EVENT } from '../desktop/useDesktopNativeCommands';
import { useDesktop } from '../desktop/DesktopContext';
import GlobalSearch from './GlobalSearch';
import QuickAddTodo from './QuickAddTodo';
import { useHeaderStats, type HeaderStats } from '../hooks/useHeaderStats';
// The plans/tasks popovers are deliberately no longer imported: the sidebar
// already carries those live counts as badges, so drawing them again in the
// toolbar spent its most valuable space restating what is on screen.
// The components stay exported from GlobalHeaderComponents for their own tests.
import { SystemHealth } from './GlobalHeaderComponents';
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
  /** Receives the element a page portals its scope control into, right of search. */
  scopeSlotRef?: React.Ref<HTMLDivElement>;
}

// System health is the only header-stats field the toolbar still renders, so
// resolving the rest would produce values nothing reads. The override prop type
// keeps its other fields on purpose: narrowing it would break callers that pass
// a whole stats fixture, for no benefit.
function resolveHeaderStats(
  override: GlobalHeaderProps['headerStatsOverride'],
  stats: HeaderStats
) {
  return { systemHealth: override?.systemHealth ?? stats.systemHealth };
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

/**
 * Closes a toolbar dropdown on any interaction outside it, or on Escape.
 *
 * The New Task caret used to be a `<details>` element, which only ever toggles
 * from its own summary: the menu stayed open while the operator clicked into
 * the page behind it. `pointerdown` is used rather than `mousedown` so touch
 * and pen input dismiss it too, and the listeners are attached only while the
 * menu is open so the resting header installs nothing on `document`.
 */
function useDismissOnOutsideInteraction(
  isOpen: boolean,
  close: () => void,
): React.RefObject<HTMLDivElement | null> {
  const containerRef = useRef<HTMLDivElement>(null);
  // Held in a ref so the effect depends only on `isOpen`; a new closure from
  // the parent's render must not tear down and re-add the listeners.
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      // The toggle itself lives inside the container, so pressing it does not
      // close here; its own onClick flips the state exactly once.
      if (!containerRef.current?.contains(event.target as Node)) closeRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return containerRef;
}

interface NewTaskButtonProps {
  disabled: boolean;
  /** Visual pressed state used by the layout preview harness. */
  pressed: boolean;
  onNewTask: () => void;
  onNewPlan: () => void;
  onNewGoal: () => void;
}

/**
 * The primary creation control as a split button.
 *
 * One shell owns the fill and the border radius and clips its children, so the
 * caret reads as the button's own disclosure rather than as a glyph floating
 * beside it. The two halves stay separate `<button>` elements because they do
 * different things and need different accessible names.
 */
const NewTaskButton: React.FC<NewTaskButtonProps> = ({
  disabled,
  pressed,
  onNewTask,
  onNewPlan,
  onNewGoal,
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const containerRef = useDismissOnOutsideInteraction(isMenuOpen, () => setIsMenuOpen(false));

  const title = disabled ? 'Demo mode is read-only' : 'New Task';
  const shell = disabled
    ? 'bg-gray-300 text-gray-600'
    : `text-white ${pressed ? 'bg-teal-800' : 'bg-teal-600'}`;
  // Applied conditionally rather than via a `disabled:` variant so a disabled
  // shell never lights up on hover while still showing its explanatory title.
  const hover = disabled ? 'cursor-not-allowed' : 'hover:bg-teal-700';

  const choose = (action: () => void) => {
    setIsMenuOpen(false);
    action();
  };

  return (
    <div ref={containerRef} className="relative flex items-center">
      <div className={`flex items-stretch overflow-hidden rounded-lg border-0 text-sm font-medium transition-colors ${shell}`}>
        <button
          type="button"
          onClick={onNewTask}
          disabled={disabled}
          title={title}
          className={`flex items-center gap-2 whitespace-nowrap px-3 py-1.5 transition-colors xl:px-4 ${hover}`}
        >
          <Zap className="h-4 w-4" aria-hidden="true" />
          <span>New Task</span>
        </button>
        {/* A hairline inset from the top and bottom edges: it separates the two
            halves without cutting the shell into two visual buttons. */}
        <span className="my-1.5 w-px flex-none bg-white/30" aria-hidden="true" />
        <button
          type="button"
          onClick={() => setIsMenuOpen(open => !open)}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          aria-label="More creation options"
          className={`flex items-center px-2 transition-colors ${hover}`}
        >
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {isMenuOpen && (
        <div
          role="menu"
          aria-label="More creation options"
          className="absolute right-0 top-full z-50 mt-1 w-36 rounded border border-slate-200 bg-white p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => choose(onNewPlan)}
            className="block w-full rounded p-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            New Plan
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => choose(onNewGoal)}
            className="block w-full rounded p-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            New Goal
          </button>
        </div>
      )}
    </div>
  );
};

const GlobalHeader: React.FC<GlobalHeaderProps> = ({ user, onLogout, onMenuToggle, MenuIcon, isDemoMode = false, headerStatsOverride, newPlanPressedOverride = false, inboxUnreadCount = null, scopeSlotRef }) => {
  const navigate = useNavigate();
  const desktop = useDesktop();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [searchRequest, setSearchRequest] = useState(0);

  const headerStats = useHeaderStats();
  const { systemHealth } = resolveHeaderStats(headerStatsOverride, headerStats);

  // Named for what it does. The old `handleNewPlan` navigated to /tasks/new,
  // which made the caret menu's real "New Plan" entry read as a duplicate.
  const handleNewTask = useCallback(() => {
    if (isDemoMode) return;
    navigate('/tasks/new');
  }, [isDemoMode, navigate]);
  // The menu entries are demo-guarded here rather than relying on the disabled
  // attribute alone, so a keyboard activation can never slip past the guard.
  const handleNewPlan = useCallback(() => {
    if (isDemoMode) return;
    navigate('/studio/new');
  }, [isDemoMode, navigate]);
  const handleNewGoal = useCallback(() => {
    if (isDemoMode) return;
    navigate('/goals?new=1');
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

  return (
    <>
    {/* Global navigation owns app-wide dropdowns, so its stacking context must stay
        above route-level sticky headers such as task details summaries. */}
    {/*
      Two regions, not three columns. Search is the toolbar's primary input, so
      it leads the bar from the left; the page's scope control sits immediately
      beside it, because scope belongs next to the thing it scopes. A flex row
      states the shrink priority in one place: the left region is `min-w-0
      flex-1` and gives way, the action region is `flex-none` and never does,
      so at 768px the search field narrows instead of anything overflowing.
    */}
    <header aria-label="Application toolbar" className="desktop-content-toolbar sticky top-0 z-40 hidden h-14 items-stretch justify-between gap-2 border-b border-slate-200 bg-slate-50 px-2 md:flex">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* The sidebar is a drawer below `lg`, so its toggle leads the row there. */}
        <button
          onClick={onMenuToggle}
          className="flex-none p-2 text-gray-500 hover:text-gray-700 lg:hidden"
          aria-label="Open menu"
        >
          <MenuIcon className="h-6 w-6" />
        </button>
        {/* `min-w-0` lets the input shrink below its nominal width rather than
            pushing the action buttons off the row at narrow desktop widths. */}
        <div data-testid="header-search" className="w-44 min-w-0 flex-shrink lg:w-60 xl:w-72">
          <GlobalSearch inputRef={searchInputRef} />
        </div>
        {/*
          The repository selector, immediately right of search. The header does
          not know which repositories a route cares about, so the current page
          portals its own control in here (see headerScopeSlot.ts). `empty:hidden`
          is what makes "only where a repository selection applies" true by
          construction: a page that mounts nothing leaves no empty box behind.
          It stays `lg:`-only because below that the Dashboard renders its own
          full-width scope bar, and drawing both would show two selectors.
        */}
        <div ref={scopeSlotRef} data-testid="header-scope-slot" className="hidden min-w-0 flex-none items-center lg:flex lg:empty:hidden" />
      </div>

      <div className="flex flex-none items-center gap-2">
        <QuickAddTodo
          externalOpen={quickAddOpen}
          onExternalOpenHandled={() => setQuickAddOpen(false)}
          disabled={isDemoMode}
        />
        <NewTaskButton
          disabled={isDemoMode}
          pressed={newPlanPressedOverride}
          onNewTask={handleNewTask}
          onNewPlan={handleNewPlan}
          onNewGoal={handleNewGoal}
        />
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

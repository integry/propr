import React, { useRef, useEffect, useLayoutEffect, useCallback, useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, Loader2 } from 'lucide-react';
import { useGlobalSearch } from '../hooks/useGlobalSearch';
import {
  SEARCH_CATEGORIES,
  SearchCategory,
  SearchItem,
  buildSearchItems,
  cycleCategory,
  getCategoryCounts,
  getItemGithubUrl,
  getItemPath,
  getPlansAction,
  getScopeAction,
  getShortcutModifierLabel,
  searchIdPrefix,
  searchListboxId,
  searchOptionId,
} from './globalSearchModel';
import { SearchPreview, SearchResultList } from './GlobalSearchResults';

interface GlobalSearchProps {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** Called after a backdrop press closes the palette, so a host modal can close too. */
  onBackdropDismiss?: (event: React.MouseEvent) => void;
}

type SearchResultState = 'loading' | 'error' | 'empty' | 'results' | 'idle';

function getSearchResultState(
  isLoading: boolean,
  error: string | null,
  query: string,
  hasResults: boolean,
): SearchResultState {
  if (isLoading && !hasResults) return 'loading';
  if (!isLoading && error) return 'error';
  if (!isLoading && query.trim() && !hasResults) return 'empty';
  return hasResults ? 'results' : 'idle';
}

const PALETTE_WIDTH = 640;
const VIEWPORT_GUTTER = 16;
/**
 * Below this much room under the input (a short or zoomed window), the tabs and a wrapped
 * hint row would leave the list less than one result row, so the palette goes compact.
 */
const COMPACT_PALETTE_HEIGHT = 128;

/**
 * Where the palette hangs: its left edge flush with the search input, 8px below it. It only
 * shifts left when the viewport is too narrow to fit it. The backdrop starts under the toolbar.
 * `compact` marks too little room below the input for the full layout.
 */
interface PaletteAnchor {
  top: number;
  left: number;
  backdropTop: number;
  compact: boolean;
}

function measureAnchor(container: HTMLElement | null): PaletteAnchor {
  const input = container?.getBoundingClientRect();
  if (!input) return { top: 0, left: VIEWPORT_GUTTER, backdropTop: 0, compact: false };
  const bar = container?.closest('header')?.getBoundingClientRect();
  const maxLeft = window.innerWidth - Math.min(PALETTE_WIDTH, window.innerWidth - 2 * VIEWPORT_GUTTER) - VIEWPORT_GUTTER;
  const top = input.bottom + 8;
  return {
    top,
    left: Math.max(VIEWPORT_GUTTER, Math.min(input.left, maxLeft)),
    backdropTop: bar ? bar.bottom : input.bottom,
    compact: window.innerHeight - top - VIEWPORT_GUTTER < COMPACT_PALETTE_HEIGHT,
  };
}

/** Track the input's position while the palette is open (the toolbar differs between web and desktop). */
function usePaletteAnchor(containerRef: React.RefObject<HTMLElement | null>, open: boolean): PaletteAnchor {
  const [anchor, setAnchor] = useState<PaletteAnchor>({ top: 0, left: 0, backdropTop: 0, compact: false });
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => setAnchor(measureAnchor(containerRef.current));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [containerRef, open]);
  return anchor;
}

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="rounded-sm border border-slate-200 bg-white px-1 py-px font-sans text-[10px] text-slate-500">{children}</kbd>
);

/** Footer keyboard hints. A compact palette gives their row to the results; the keys still work. */
const KeyHints: React.FC<{ modifierKey: string; compact: boolean }> = ({ modifierKey, compact }) => compact ? null : (
  <>
    <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate</span>
    <span><Kbd>Tab</Kbd> filter</span>
    <span><Kbd>↵</Kbd> open</span>
    <span><Kbd>{modifierKey}↵</Kbd> GitHub</span>
    <span><Kbd>Esc</Kbd> close</span>
  </>
);

/**
 * No results. A compact palette drops the icon and padding, and a long query's message
 * scrolls on its own, so "Search all tasks" always keeps its full row.
 */
const EmptyResults: React.FC<{ query: string; compact: boolean; onSearchAllTasks: () => void }> = ({ query, compact, onSearchAllTasks }) => (
  <div className={`flex min-h-0 flex-col items-center px-4 text-center ${compact ? 'py-2' : 'py-8'}`}>
    {!compact && <Search className="w-6 h-6 flex-none text-slate-300 mx-auto mb-2" />}
    <p className="min-h-0 max-w-full overflow-y-auto break-words text-sm text-slate-500 scrollbar-subtle">No results found for "{query}"</p>
    <button
      onClick={onSearchAllTasks}
      className={`${compact ? 'mt-1' : 'mt-3'} flex-none text-xs text-primary-600 hover:text-primary-700 transition-colors`}
    >
      Search all tasks
    </button>
  </div>
);

/**
 * Global search as a master–preview command palette: a single linear result
 * list on the left (↑/↓ walk it, Tab cycles category scopes) and a live
 * preview of the highlighted result on the right.
 */
const GlobalSearch: React.FC<GlobalSearchProps> = ({ inputRef: externalInputRef, onBackdropDismiss }) => {
  const navigate = useNavigate();
  const internalInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef || internalInputRef;
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const idPrefix = searchIdPrefix(useId());
  const [category, setCategory] = useState<SearchCategory>('all');
  const [activeIndex, setActiveIndex] = useState(0);

  const {
    query,
    results,
    isLoading,
    isOpen,
    error,
    hasResults,
    setQuery,
    clearSearch,
    setIsOpen,
  } = useGlobalSearch();

  const counts = useMemo(() => getCategoryCounts(results), [results]);
  const items = useMemo(() => buildSearchItems(results, category), [results, category]);
  const activeItem: SearchItem | undefined = items[activeIndex];
  const modifierKey = useMemo(() => getShortcutModifierLabel(), []);

  // A new result set starts from the top of the full list. Reset while rendering,
  // not in an effect, so a pending reset can't undo a Tab pressed right after
  // the results appear.
  const [scopedResults, setScopedResults] = useState(results);
  if (scopedResults !== results) {
    setScopedResults(results);
    setCategory('all');
    setActiveIndex(0);
  }

  // Keep the highlighted row visible as the keyboard walks the list. When the list is
  // shorter than the row (a short window), its title still comes fully into view.
  // Resizing or zooming with Search open changes the list's room (its height, and how
  // titles wrap) but not the selection, so a window resize or a change in the list's
  // height (the palette re-anchoring, going compact) reveals the row again too.
  useEffect(() => {
    const list = listRef.current;
    if (!activeItem || !list) return;
    const reveal = () => {
      const option = list.querySelector(`#${searchOptionId(idPrefix, activeItem.key)}`);
      option?.scrollIntoView?.({ block: 'nearest' });
      option?.querySelector('[data-search-option-title]')?.scrollIntoView?.({ block: 'nearest' });
    };
    reveal();
    window.addEventListener('resize', reveal);
    let height = list.clientHeight;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (list.clientHeight === height) return;
      height = list.clientHeight;
      reveal();
    });
    observer?.observe(list);
    return () => {
      window.removeEventListener('resize', reveal);
      observer?.disconnect();
    };
  }, [activeItem, idPrefix]);

  // Handle click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, setIsOpen]);

  const openItem = useCallback((item: SearchItem) => {
    navigate(getItemPath(item));
    clearSearch();
  }, [navigate, clearSearch]);

  const openOnGithub = useCallback((item: SearchItem) => {
    const url = getItemGithubUrl(item);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const handleViewAllTasks = useCallback(() => {
    navigate(`/tasks?search=${encodeURIComponent(query.trim())}`);
    clearSearch();
  }, [navigate, clearSearch, query]);

  const scopeAction = getScopeAction(category, query);
  const plansAction = getPlansAction(category, counts, query);
  const followAction = useCallback((path: string) => {
    navigate(path);
    clearSearch();
  }, [navigate, clearSearch]);

  const selectCategory = (next: SearchCategory) => {
    setCategory(next);
    setActiveIndex(0);
  };

  const showDropdown = Boolean(isOpen && (hasResults || isLoading || query.trim()));
  const anchor = usePaletteAnchor(containerRef, showDropdown);

  const resultState = getSearchResultState(isLoading, error, query, hasResults);
  const navigable = showDropdown && items.length > 0;

  // Keyboard navigation: one linear list, Tab scopes categories.
  const handleListKey = (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
    if (!navigable || !activeItem) return false;
    if (e.key === 'ArrowDown') setActiveIndex(index => (index + 1) % items.length);
    else if (e.key === 'ArrowUp') setActiveIndex(index => (index - 1 + items.length) % items.length);
    else if (e.key === 'Enter' && e.shiftKey) followAction(scopeAction.path);
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) openOnGithub(activeItem);
    else if (e.key === 'Enter') openItem(activeItem);
    else return false;
    e.preventDefault();
    return true;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
      inputRef.current?.blur();
    } else if (e.key === 'Tab' && showDropdown && hasResults) {
      e.preventDefault();
      selectCategory(cycleCategory(category, counts, e.shiftKey ? -1 : 1));
    } else if (!handleListKey(e) && e.key === 'Enter' && query.trim()) {
      handleViewAllTasks();
    }
  };

  // Handle input focus
  const handleFocus = () => {
    if (query.trim()) {
      setIsOpen(true);
    }
  };

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          aria-label="Search"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={searchListboxId(idPrefix)}
          aria-autocomplete="list"
          aria-activedescendant={navigable && activeItem ? searchOptionId(idPrefix, activeItem.key) : undefined}
          placeholder="Search..."
          className="w-full rounded-lg border-0 bg-slate-100 py-1.5 pl-9 pr-14 text-sm text-gray-900 shadow-inner placeholder-gray-400 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 sm:py-2 sm:pl-12 sm:pr-16"
        />
        {/* Clear button or loading indicator */}
        {query && (
          <button
            onClick={clearSearch}
            aria-label="Clear search"
            className="absolute right-2 sm:right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-200 rounded transition-colors"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
            ) : (
              <X className="w-4 h-4 text-gray-400" />
            )}
          </button>
        )}
        {!query && (
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-400 sm:right-3">
            {modifierKey}K
          </kbd>
        )}
      </div>

      {/* Results palette: the Studio mega-dropdown (640px wide, up to 70vh tall),
          left-aligned with the search input just below it, over a dimmed backdrop.
          It never runs past the window's lower edge, even when the input sits
          lower (the narrow Search sheet below the Linux window controls).
          Clicking the backdrop closes it. */}
      {showDropdown && (
        <div
          data-testid="global-search-backdrop"
          aria-hidden="true"
          onMouseDown={event => {
            setIsOpen(false);
            onBackdropDismiss?.(event);
          }}
          className="fixed inset-x-0 bottom-0 z-40 bg-black/40 backdrop-blur-sm"
          style={{ top: anchor.backdropTop }}
        />
      )}
      {showDropdown && (
        <div
          data-testid="global-search-palette"
          className="desktop-toolbar-popover fixed z-50 flex max-h-[70vh] w-[640px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-2xl ring-1 ring-black/5"
          style={{ top: anchor.top, left: anchor.left, maxHeight: `min(70vh, calc(100% - ${anchor.top + VIEWPORT_GUTTER}px))` }}
        >
          {resultState === 'loading' && (
            <div className="px-4 py-8 text-center">
              <Loader2 className="w-6 h-6 text-slate-400 animate-spin mx-auto mb-2" />
              <p className="text-sm text-slate-500">Searching...</p>
            </div>
          )}

          {resultState === 'error' && (
            <div role="alert" className="px-4 py-8 text-center">
              <p className="text-sm font-medium text-red-700">Couldn’t search</p>
              <p className="mt-1 text-xs text-red-600">{error}</p>
            </div>
          )}

          {resultState === 'empty' && <EmptyResults query={query} compact={anchor.compact} onSearchAllTasks={handleViewAllTasks} />}

          {hasResults && (
            <>
              {/* Category scopes: Tab / Shift+Tab cycles them from the input. */}
              <div role="tablist" aria-label="Result type" className="flex flex-none items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1.5">
                {SEARCH_CATEGORIES.map(({ id, label }) => {
                  const selected = category === id;
                  const disabled = id !== 'all' && counts[id] === 0;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      tabIndex={-1}
                      aria-selected={selected}
                      disabled={disabled}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => selectCategory(id)}
                      className={`rounded-sm px-2 py-0.5 text-xs font-medium transition-colors ${
                        selected
                          ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                          : 'text-slate-500 hover:text-slate-800 disabled:cursor-default disabled:text-slate-300'
                      }`}
                    >
                      {label} <span className="tabular-nums text-slate-400">({counts[id]})</span>
                    </button>
                  );
                })}
              </div>

              <div className="flex min-h-0 flex-1">
                <div ref={listRef} className="min-w-0 flex-1 overflow-y-auto scrollbar-subtle md:basis-3/5">
                  <SearchResultList idPrefix={idPrefix} items={items} activeIndex={activeIndex} onHover={setActiveIndex} onSelect={openItem} />
                </div>
                {activeItem && (
                  <div className="hidden min-w-0 basis-2/5 border-l border-slate-200 bg-slate-50 md:block">
                    <SearchPreview item={activeItem} onOpen={openItem} shortcutKey={modifierKey} />
                  </div>
                )}
              </div>

              <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-[10px] text-slate-500">
                <KeyHints modifierKey={modifierKey} compact={anchor.compact} />
                <span className="ml-auto flex min-w-0 items-center gap-3">
                  {plansAction && (
                    <button
                      type="button"
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => followAction(plansAction.path)}
                      className="min-w-0 truncate text-primary-600 hover:text-primary-700"
                    >
                      {plansAction.label} →
                    </button>
                  )}
                  <button
                    type="button"
                    aria-keyshortcuts="Shift+Enter"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => followAction(scopeAction.path)}
                    className="flex min-w-0 items-center gap-1 text-primary-600 hover:text-primary-700"
                  >
                    <span className="truncate">{scopeAction.label} →</span>
                    <span aria-hidden="true"><Kbd>⇧↵</Kbd></span>
                  </button>
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default GlobalSearch;

import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
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
  searchOptionId,
} from './globalSearchModel';
import { SearchPreview, SearchResultList } from './GlobalSearchResults';

interface GlobalSearchProps {
  inputRef?: React.RefObject<HTMLInputElement | null>;
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

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="rounded-sm border border-slate-200 bg-white px-1 py-px font-sans text-[10px] text-slate-500">{children}</kbd>
);

/**
 * Global search as a master–preview command palette: a single linear result
 * list on the left (↑/↓ walk it, Tab cycles category scopes) and a live
 * preview of the highlighted result on the right.
 */
const GlobalSearch: React.FC<GlobalSearchProps> = ({ inputRef: externalInputRef }) => {
  const navigate = useNavigate();
  const internalInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef || internalInputRef;
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
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

  // A new result set starts from the top of the full list.
  useEffect(() => {
    setCategory('all');
    setActiveIndex(0);
  }, [results]);

  // Keep the highlighted row visible as the keyboard walks the list.
  useEffect(() => {
    if (!activeItem) return;
    const option = listRef.current?.querySelector(`#${searchOptionId(activeItem.key)}`);
    option?.scrollIntoView?.({ block: 'nearest' });
  }, [activeItem]);

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

  const selectCategory = (next: SearchCategory) => {
    setCategory(next);
    setActiveIndex(0);
  };

  const showDropdown = Boolean(isOpen && (hasResults || isLoading || query.trim()));
  const resultState = getSearchResultState(isLoading, error, query, hasResults);
  const navigable = showDropdown && items.length > 0;

  // Keyboard navigation: one linear list, Tab scopes categories.
  const handleListKey = (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
    if (!navigable || !activeItem) return false;
    if (e.key === 'ArrowDown') setActiveIndex(index => (index + 1) % items.length);
    else if (e.key === 'ArrowUp') setActiveIndex(index => (index - 1 + items.length) % items.length);
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
          aria-controls="global-search-listbox"
          aria-autocomplete="list"
          aria-activedescendant={navigable && activeItem ? searchOptionId(activeItem.key) : undefined}
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
            ⌘K
          </kbd>
        )}
      </div>

      {/* Results palette: the Studio mega-dropdown (640px wide, up to 70vh tall). */}
      {showDropdown && (
        <div
          data-testid="global-search-palette"
          className="desktop-toolbar-popover absolute left-0 top-full z-50 mt-1 flex max-h-[70vh] w-[640px] max-w-[calc(100vw-4rem)] flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-2xl ring-1 ring-black/5"
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

          {resultState === 'empty' && (
            <div className="px-4 py-8 text-center">
              <Search className="w-6 h-6 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-500">No results found for "{query}"</p>
              <button
                onClick={handleViewAllTasks}
                className="mt-3 text-xs text-primary-600 hover:text-primary-700 transition-colors"
              >
                Search all tasks
              </button>
            </div>
          )}

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
                  <SearchResultList items={items} activeIndex={activeIndex} onHover={setActiveIndex} onSelect={openItem} />
                </div>
                {activeItem && (
                  <div className="hidden min-w-0 basis-2/5 border-l border-slate-200 bg-slate-50 md:block">
                    <SearchPreview item={activeItem} onOpen={openItem} shortcutKey="⌘" />
                  </div>
                )}
              </div>

              <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-[10px] text-slate-500">
                <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate</span>
                <span><Kbd>Tab</Kbd> filter</span>
                <span><Kbd>↵</Kbd> open</span>
                <span><Kbd>⌘↵</Kbd> GitHub</span>
                <span><Kbd>Esc</Kbd> close</span>
                <button
                  type="button"
                  onMouseDown={e => e.preventDefault()}
                  onClick={handleViewAllTasks}
                  className="ml-auto text-primary-600 hover:text-primary-700"
                >
                  Search all tasks →
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default GlobalSearch;

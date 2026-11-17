import React from 'react';
import { useIsMobile } from '../hooks/useIsMobile';
import { ListSearchInput } from './ListSearchInput';

export interface ListPageHeaderSearch {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  /** Accessible name, e.g. "Search goals". */
  label: string;
  /** The longest query the list accepts. */
  maxLength?: number;
}

interface ListPageHeaderProps {
  title: string;
  /** Id of the heading, for a section labelled by it. */
  titleId?: string;
  /** The list's search field; it sits beside the filters, or on its own row on a phone. */
  search?: ListPageHeaderSearch;
  /** The list's filter controls, laid out by the caller (e.g. a status select and a RepositorySelector). */
  filters?: React.ReactNode;
  /** False hides the search and filters, e.g. while a list has nothing to filter. */
  showControls?: boolean;
  'data-testid'?: string;
}

/*
  Below this width a header that is not on a phone — the list pane of a split
  layout — puts the search and filters on a row under the title instead of
  squeezing them beside it. A full-width list from `sm` up is always wider,
  so this never applies there.
*/
const NARROW_ROW = '[@container(max-width:36rem)]:flex-wrap [@container(max-width:36rem)]:gap-y-2';
const NARROW_CONTROLS = '[@container(max-width:36rem)]:basis-full [@container(max-width:36rem)]:gap-2';
const NARROW_SEARCH = '[@container(max-width:36rem)]:max-w-none';

/**
 * The header shared by the Goals, Plans and Automations lists: the page title
 * on the left, then search and filters right-aligned beside it; a phone moves
 * the search onto its own row under the title and filters. Callers keep their
 * own query, debounce and URL handling.
 */
export const ListPageHeader: React.FC<ListPageHeaderProps> = ({
  title, titleId, search, filters, showControls = true, 'data-testid': testId,
}) => {
  const isMobile = useIsMobile();
  // A phone has its own layout below, so the narrow-pane wrap only applies from `sm` up.
  const narrow = (classes: string) => (isMobile ? '' : classes);
  return (
    <header data-testid={testId} className="flex-none border-b border-gray-200 bg-slate-50 px-4 py-2 [container-type:inline-size] sm:px-6 sm:py-4">
      <div className={`flex items-center justify-between gap-2 sm:gap-4 ${narrow(NARROW_ROW)}`}>
        <h1 id={titleId} className="flex-none text-lg font-bold text-gray-800 sm:text-2xl">{title}</h1>
        {showControls && (search || filters) && (
          <div className={`flex min-w-0 flex-1 items-center justify-end gap-2 sm:gap-4 ${narrow(NARROW_CONTROLS)}`}>
            {search && !isMobile && (
              <ListSearchInput
                value={search.value}
                onChange={search.onChange}
                onClear={search.onClear}
                label={search.label}
                maxLength={search.maxLength}
                // The search gives up width before the filters do (up to 16rem), so both fit beside the title.
                className={`hidden min-w-0 max-w-64 flex-1 sm:block ${narrow(NARROW_SEARCH)}`}
              />
            )}
            {filters}
          </div>
        )}
      </div>
      {/* A phone has no room for search beside the filters, so it takes its own row. */}
      {showControls && search && isMobile && (
        <ListSearchInput
          value={search.value}
          onChange={search.onChange}
          onClear={search.onClear}
          label={search.label}
          maxLength={search.maxLength}
          className="mt-2 sm:hidden"
          touch
        />
      )}
    </header>
  );
};

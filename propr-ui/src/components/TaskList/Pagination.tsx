import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const formatCount = (value: number): string => value.toLocaleString('en-US');

interface PaginationProps {
  hideFilters?: boolean;
  totalTasks: number;
  tasksPerPage: number;
  currentPage: number;
  setCurrentPage: (page: number | ((prev: number) => number)) => void;
  /** Tasks the page actually returned; the range ends there rather than at the page size. */
  returnedCount?: number;
  /** A footer pinned under the list stays there with a single page, or none: it still states the count. */
  pinned?: boolean;
}

/**
 * `Showing 1–25 of 1,842 tasks`: the slice and the whole, and nothing else.
 * The list pages by task (a pull request or issue), the same unit as its rows;
 * a task's runs come with it and are counted in its `N runs` chip, never here.
 */

export const Pagination: React.FC<PaginationProps> = ({
  hideFilters,
  totalTasks,
  tasksPerPage,
  currentPage,
  setCurrentPage,
  returnedCount,
  pinned = false,
}) => {
  if (hideFilters || (!pinned && totalTasks <= tasksPerPage)) {
    return null;
  }

  const totalPages = Math.max(1, Math.ceil(totalTasks / tasksPerPage));
  // Convert from 0-based internal state to 1-based display
  const displayPage = currentPage + 1;
  const firstTask = Math.min(currentPage * tasksPerPage + 1, totalTasks);
  const lastTask = Math.min(currentPage * tasksPerPage + (returnedCount ?? tasksPerPage), totalTasks);

  return (
    <div className="flex items-center justify-between px-4 sm:px-6 py-2 gap-2">
      <span data-testid="pagination-summary" className="text-xs sm:text-sm text-gray-600">
        {totalTasks === 0 ? '0 tasks' : (
          <><span className="hidden sm:inline">Showing </span>{formatCount(firstTask)}–{formatCount(lastTask)}<span className="hidden sm:inline"> of {formatCount(totalTasks)} tasks</span></>
        )}
      </span>
      <div className="flex items-center gap-1 sm:gap-2">
        <button
          onClick={() => setCurrentPage(prev => Math.max(prev - 1, 0))}
          disabled={currentPage === 0}
          className="inline-flex items-center gap-1 px-2 sm:px-3 py-1 sm:py-1.5 text-xs sm:text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft size={14} className="sm:w-4 sm:h-4" />
          <span className="hidden sm:inline">Previous</span>
        </button>
        <span className="text-xs sm:text-sm text-gray-600 px-1">
          {formatCount(displayPage)}/{formatCount(totalPages)}
        </span>
        <button
          onClick={() => setCurrentPage(prev => (prev + 1) * tasksPerPage < totalTasks ? prev + 1 : prev)}
          disabled={(currentPage + 1) * tasksPerPage >= totalTasks}
          className="inline-flex items-center gap-1 px-2 sm:px-3 py-1 sm:py-1.5 text-xs sm:text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight size={14} className="sm:w-4 sm:h-4" />
        </button>
      </div>
    </div>
  );
};

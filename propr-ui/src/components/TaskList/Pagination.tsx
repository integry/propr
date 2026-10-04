import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const formatCount = (value: number): string => value.toLocaleString('en-US');

interface PaginationProps {
  hideFilters?: boolean;
  totalTasks: number;
  tasksPerPage: number;
  currentPage: number;
  setCurrentPage: (page: number | ((prev: number) => number)) => void;
  /** Runs the page actually returned; the range ends there rather than at the page size. */
  returnedCount?: number;
}

/**
 * `Showing 1–100 of 14,769 runs`: the slice and the whole, and nothing else.
 * The API pages through runs (agent sessions), not tasks, and a row folds a
 * task's runs together behind its `N runs` chip, so the range is counted in
 * runs: a task count here would promise rows the page does not have.
 */

export const Pagination: React.FC<PaginationProps> = ({
  hideFilters,
  totalTasks,
  tasksPerPage,
  currentPage,
  setCurrentPage,
  returnedCount,
}) => {
  if (hideFilters || totalTasks <= tasksPerPage) {
    return null;
  }

  const totalPages = Math.ceil(totalTasks / tasksPerPage);
  // Convert from 0-based internal state to 1-based display
  const displayPage = currentPage + 1;
  const firstTask = currentPage * tasksPerPage + 1;
  const lastTask = Math.min(currentPage * tasksPerPage + (returnedCount ?? tasksPerPage), totalTasks);

  return (
    <div className="flex items-center justify-between px-4 sm:px-6 py-2 gap-2">
      <span data-testid="pagination-summary" className="text-xs sm:text-sm text-gray-600">
        <span className="hidden sm:inline">Showing </span>{formatCount(firstTask)}–{formatCount(lastTask)}<span className="hidden sm:inline"> of {formatCount(totalTasks)} runs</span>
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

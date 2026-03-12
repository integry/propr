import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationProps {
  hideFilters?: boolean;
  totalTasks: number;
  tasksPerPage: number;
  currentPage: number;
  setCurrentPage: (page: number | ((prev: number) => number)) => void;
}

export const Pagination: React.FC<PaginationProps> = ({
  hideFilters,
  totalTasks,
  tasksPerPage,
  currentPage,
  setCurrentPage
}) => {
  if (hideFilters || totalTasks <= tasksPerPage) {
    return null;
  }

  const totalPages = Math.ceil(totalTasks / tasksPerPage);
  // Convert from 0-based internal state to 1-based display
  const displayPage = currentPage + 1;

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between px-6 py-4 gap-3">
      <span className="text-sm text-gray-600 text-center sm:text-left">
        Showing {currentPage * tasksPerPage + 1}-{Math.min((currentPage + 1) * tasksPerPage, totalTasks)} of {totalTasks} tasks
      </span>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          onClick={() => setCurrentPage(prev => Math.max(prev - 1, 0))}
          disabled={currentPage === 0}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft size={16} />
          Previous
        </button>
        <span className="text-sm text-gray-600 px-2">
          Page {displayPage} of {totalPages}
        </span>
        <button
          onClick={() => setCurrentPage(prev => (prev + 1) * tasksPerPage < totalTasks ? prev + 1 : prev)}
          disabled={(currentPage + 1) * tasksPerPage >= totalTasks}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Next
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
};

import React from 'react';

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

  return (
    <div className="flex justify-between items-center mt-4 px-2">
      <div className="text-sm text-gray-500">
        Showing {currentPage * tasksPerPage + 1} - {Math.min((currentPage + 1) * tasksPerPage, totalTasks)} of {totalTasks} tasks
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => setCurrentPage(prev => Math.max(prev - 1, 0))}
          disabled={currentPage === 0}
          className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <button
          onClick={() => setCurrentPage(prev => (prev + 1) * tasksPerPage < totalTasks ? prev + 1 : prev)}
          disabled={(currentPage + 1) * tasksPerPage >= totalTasks}
          className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  );
};

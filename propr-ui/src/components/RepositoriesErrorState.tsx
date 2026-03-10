import React from 'react';

interface RepositoriesErrorStateProps {
  error: string;
  onRetry: () => void;
}

export const RepositoriesErrorState: React.FC<RepositoriesErrorStateProps> = ({ error, onRetry }) => (
  <div className="p-4 sm:p-8">
    <h2 className="text-gray-900 text-2xl font-semibold mb-4">Manage Monitored Repositories</h2>
    <div className="p-6 bg-red-50 border border-red-200 rounded-md">
      <div className="flex items-start gap-3">
        <svg className="h-5 w-5 text-red-500 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <div>
          <h3 className="text-red-800 font-medium">Failed to load repositories</h3>
          <p className="text-red-700 mt-1">{error}</p>
          <button
            onClick={onRetry}
            className="mt-3 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-md text-sm font-medium transition-colors"
          >
            Try Again
          </button>
        </div>
      </div>
    </div>
  </div>
);

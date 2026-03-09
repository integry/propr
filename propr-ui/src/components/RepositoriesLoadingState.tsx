import React from 'react';

export const RepositoriesLoadingState: React.FC = () => (
  <div className="p-4 sm:p-8">
    <h2 className="text-gray-900 text-2xl font-semibold mb-4">Manage Monitored Repositories</h2>
    <div className="flex items-center justify-center py-12">
      <div className="flex items-center gap-3 text-gray-600">
        <svg className="animate-spin h-5 w-5 text-primary-600" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <span>Loading repositories...</span>
      </div>
    </div>
  </div>
);

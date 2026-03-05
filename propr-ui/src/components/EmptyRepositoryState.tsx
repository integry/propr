import React from 'react';

export const EmptyRepositoryState: React.FC = () => (
  <div className="text-center py-16 px-6 bg-gradient-to-b from-gray-50 to-white border border-gray-200 rounded-lg shadow-sm">
    <div className="flex justify-center mb-6">
      <div className="w-20 h-20 rounded-full bg-primary-50 flex items-center justify-center">
        <svg className="h-10 w-10 text-primary-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 11v4m0 0l-2-2m2 2l2-2" />
        </svg>
      </div>
    </div>
    <h3 className="text-lg font-semibold text-gray-900 mb-3">Welcome! Add Your First Repository</h3>
    <p className="text-gray-600 mb-4 max-w-md mx-auto">
      Repositories are the foundation of ProPR. Add a repository to enable AI-powered code reviews,
      automated planning, and intelligent monitoring for your projects.
    </p>
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-4 text-sm text-gray-500">
        <span className="flex items-center gap-1.5">
          <svg className="h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          AI Code Reviews
        </span>
        <span className="flex items-center gap-1.5">
          <svg className="h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Smart Planning
        </span>
        <span className="flex items-center gap-1.5">
          <svg className="h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Codebase Indexing
        </span>
      </div>
      <p className="text-sm text-gray-400 mt-2">
        Use the form above to select a repository from your GitHub account.
      </p>
    </div>
  </div>
);

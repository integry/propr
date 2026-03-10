import React from 'react';

// --- Icons ---

const FolderIcon: React.FC<{ className?: string }> = ({ className = "w-8 h-8" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
  </svg>
);

export const EmptyRepositoryState: React.FC = () => (
  <div className="text-center py-12 px-4">
    <div className="flex justify-center mb-4">
      <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center">
        <FolderIcon className="w-8 h-8 text-gray-400" />
      </div>
    </div>
    <h3 className="text-gray-900 font-medium text-base mb-2">No repositories configured</h3>
    <p className="text-gray-500 text-sm mb-4 max-w-sm mx-auto">
      Add repositories to enable AI-powered code reviews, automated planning, and intelligent monitoring.
    </p>
    <p className="text-xs text-gray-400 font-mono">
      Click "+ Add Repository" above to get started
    </p>
  </div>
);

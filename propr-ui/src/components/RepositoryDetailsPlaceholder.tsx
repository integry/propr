import React from 'react';

interface RepositoryDetailsPlaceholderProps {
  selectedRepo?: {
    name: string;
    alias?: string;
  } | null;
}

export const RepositoryDetailsPlaceholder: React.FC<RepositoryDetailsPlaceholderProps> = ({ selectedRepo }) => {
  if (selectedRepo) {
    return (
      <div className="text-center p-8">
        <div className="text-gray-400 mb-2">
          <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        </div>
        <h3 className="text-lg font-medium text-gray-700 mb-1">
          {selectedRepo.alias || selectedRepo.name}
        </h3>
        <p className="text-sm text-gray-500">
          Chat and improvement features coming soon.
        </p>
      </div>
    );
  }

  return (
    <div className="text-center p-8">
      <div className="text-gray-300 mb-2">
        <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
      </div>
      <p className="text-sm text-gray-400">
        Select a repository to view details
      </p>
    </div>
  );
};

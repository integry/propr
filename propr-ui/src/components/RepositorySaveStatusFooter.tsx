import React from 'react';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface RepositorySaveStatusFooterProps {
  saveStatus: SaveStatus;
  error?: string | null;
}

export const RepositorySaveStatusFooter: React.FC<RepositorySaveStatusFooterProps> = ({ saveStatus, error }) => {
  return (
    <div className="flex-shrink-0 border-t border-gray-200 px-6 py-3 bg-gray-50">
      <div className="flex items-center justify-between">
        {/* Left Side - Status Message */}
        <div className="flex items-center gap-2">
          {saveStatus === 'saving' && (
            <span className="flex items-center gap-1.5 text-xs text-gray-500 font-mono">
              <svg className="animate-spin h-3 w-3 text-gray-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Saving changes...
            </span>
          )}
          {saveStatus === 'saved' && (
            <span className="flex items-center gap-1.5 text-xs text-gray-500 font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
              Changes auto-saved
            </span>
          )}
          {saveStatus === 'error' && error && (
            <span className="flex items-center gap-1.5 text-xs text-red-600 font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
              {error}
            </span>
          )}
          {saveStatus === 'idle' && (
            <span className="flex items-center gap-1.5 text-xs text-gray-400 font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-300"></span>
              All changes saved
            </span>
          )}
        </div>

        {/* Right Side - Reserved for action buttons if needed */}
        <div className="flex items-center gap-2">
          {/* Action buttons would go here if needed */}
        </div>
      </div>
    </div>
  );
};

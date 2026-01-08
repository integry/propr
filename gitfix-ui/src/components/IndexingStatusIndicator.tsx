import React from 'react';
import { RepositoryIndexingStatus } from '../api/gitfixApi';

interface IndexingStatusIndicatorProps {
  status: RepositoryIndexingStatus | undefined;
  onStop?: () => void;
}

const formatTimestamp = (ts: string | null) => {
  if (!ts) return 'Never';
  const date = new Date(ts);
  return date.toLocaleString();
};

export const IndexingStatusIndicator: React.FC<IndexingStatusIndicatorProps> = ({ status, onStop }) => {
  if (!status) {
    // No indexing info available - show idle/default state
    return (
      <div className="flex items-center gap-1.5" title="No indexing info">
        <div className="w-2 h-2 rounded-full bg-gray-300"></div>
      </div>
    );
  }

  switch (status.indexing_status) {
    case 'indexing':
      return (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5" title="Indexing codebase...">
            <svg className="animate-spin h-4 w-4 text-blue-500" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-xs text-blue-600">Indexing...</span>
          </div>
          {onStop && (
            <button
              onClick={(e) => {
                e.preventDefault();
                onStop();
              }}
              className="p-1 hover:bg-red-100 rounded text-red-600 transition-colors"
              title="Stop Indexing"
            >
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" />
              </svg>
            </button>
          )}
        </div>
      );
    case 'completed':
      return (
        <div className="flex items-center gap-1.5" title={`Index up to date. Last indexed: ${formatTimestamp(status.last_indexed_at)}`}>
          <svg className="h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {status.last_indexed_at && (
            <span className="text-xs text-gray-500">
              {formatTimestamp(status.last_indexed_at)}
            </span>
          )}
        </div>
      );
    case 'failed':
      return (
        <div className="flex items-center gap-1.5" title="Indexing failed. Check logs.">
          <svg className="h-4 w-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-xs text-red-600">Failed</span>
        </div>
      );
    case 'idle':
    default:
      return (
        <div className="flex items-center gap-1.5" title="Not indexed">
          <div className="w-2 h-2 rounded-full bg-gray-300"></div>
          <span className="text-xs text-gray-500">Not indexed</span>
        </div>
      );
  }
};

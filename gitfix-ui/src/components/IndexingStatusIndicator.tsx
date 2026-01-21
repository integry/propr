import React from 'react';
import { RepositoryIndexingStatus } from '../api/repoIndexingApi';

interface IndexingStatusIndicatorProps {
  status: RepositoryIndexingStatus | undefined;
  onStop?: () => void;
  onReindex?: () => void;
}

const formatTimestamp = (ts: string | null) => {
  if (!ts) return 'Never';
  const date = new Date(ts);
  return date.toLocaleString();
};

const formatTokens = (tokens: number): string => {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return tokens.toString();
};

const shortenHash = (hash: string | null): string => {
  if (!hash) return '';
  return hash.substring(0, 7);
};

const truncateMessage = (message: string | null, maxLength: number = 50): string => {
  if (!message) return '';
  const firstLine = message.split('\n')[0];
  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.substring(0, maxLength - 3) + '...';
};

export const IndexingStatusIndicator: React.FC<IndexingStatusIndicatorProps> = ({ status, onStop, onReindex }) => {
  const ReindexButton = () => onReindex ? (
    <button
      onClick={(e) => {
        e.preventDefault();
        onReindex();
      }}
      className="p-1 hover:bg-blue-100 rounded text-blue-600 transition-colors"
      title="Reindex Repository"
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    </button>
  ) : null;

  if (!status) {
    // No indexing info available - show idle/default state
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5" title="No indexing info">
          <div className="w-2 h-2 rounded-full bg-gray-300"></div>
        </div>
        <ReindexButton />
      </div>
    );
  }

  switch (status.indexing_status) {
    case 'indexing': {
      const progress = status.progress;
      let progressText = 'Starting...';
      let tooltipText = 'Indexing codebase...';

      if (progress) {
        if (progress.phase === 'directories') {
          const dirPercent = progress.totalDirectories > 0
            ? Math.round((progress.processedDirectories / progress.totalDirectories) * 100)
            : 0;
          progressText = `Dirs: ${dirPercent}% (${progress.processedDirectories}/${progress.totalDirectories})`;
          tooltipText = `Files: ${progress.processedFiles}/${progress.totalFiles} complete\nDirectories: ${progress.processedDirectories}/${progress.totalDirectories}\nTokens: ${progress.inputTokens.toLocaleString()} input, ${progress.outputTokens.toLocaleString()} output`;
        } else {
          progressText = `${progress.percentComplete}% (${progress.processedFiles}/${progress.totalFiles} files)`;
          tooltipText = `Indexing: ${progress.processedFiles}/${progress.totalFiles} files\nTokens: ${progress.inputTokens.toLocaleString()} input, ${progress.outputTokens.toLocaleString()} output`;
        }
      }

      const tokenText = progress && (progress.inputTokens > 0 || progress.outputTokens > 0)
        ? `${formatTokens(progress.inputTokens)} in / ${formatTokens(progress.outputTokens)} out`
        : '';

      return (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5" title={tooltipText}>
            <svg className="animate-spin h-4 w-4 text-blue-500" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-xs text-blue-600">{progressText}</span>
            {tokenText && (
              <span className="text-xs text-gray-400 ml-1">({tokenText})</span>
            )}
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
    }
    case 'completed': {
      const shortHash = shortenHash(status.last_indexed_hash);
      const commitMessage = truncateMessage(status.last_indexed_commit_message);
      const fullTooltip = [
        `Index up to date`,
        `Last indexed: ${formatTimestamp(status.last_indexed_at)}`,
        status.last_indexed_hash ? `Commit: ${status.last_indexed_hash}` : null,
        status.last_indexed_commit_message ? `Message: ${status.last_indexed_commit_message}` : null
      ].filter(Boolean).join('\n');

      return (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5" title={fullTooltip}>
            <svg className="h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {shortHash && status.full_name && (
              <a
                href={`https://github.com/${status.full_name}/commit/${status.last_indexed_hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-mono text-gray-600 bg-gray-100 px-1 rounded hover:bg-gray-200 hover:text-blue-600 transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                {shortHash}
              </a>
            )}
            {shortHash && !status.full_name && (
              <span className="text-xs font-mono text-gray-600 bg-gray-100 px-1 rounded">
                {shortHash}
              </span>
            )}
            {commitMessage && (
              <span className="text-xs text-gray-500 truncate max-w-[200px]">
                {commitMessage}
              </span>
            )}
            {!shortHash && status.last_indexed_at && (
              <span className="text-xs text-gray-500">
                {formatTimestamp(status.last_indexed_at)}
              </span>
            )}
          </div>
          <ReindexButton />
        </div>
      );
    }
    case 'failed':
      return (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5" title="Indexing failed. Click to retry.">
            <svg className="h-4 w-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="text-xs text-red-600">Failed</span>
          </div>
          <ReindexButton />
        </div>
      );
    case 'idle':
    default:
      return (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5" title="Not indexed">
            <div className="w-2 h-2 rounded-full bg-gray-300"></div>
            <span className="text-xs text-gray-500">Not indexed</span>
          </div>
          <ReindexButton />
        </div>
      );
  }
};

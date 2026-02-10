import React, { useMemo, useState, useCallback } from 'react';
import { FileCode, FileText, FileJson, File, FolderOpen, Check } from 'lucide-react';
import { PreviewResult } from '../../api/gitfixApi';

interface SmartFileSelectionProps {
  smartSelection: PreviewResult['smartSelection'];
  totalTokens?: number;
  costEstimate?: number;
}

// Get appropriate icon for file type
const getFileIcon = (path: string): React.ReactNode => {
  const ext = path.split('.').pop()?.toLowerCase();
  const iconClass = "w-4 h-4 flex-shrink-0";

  switch (ext) {
    case 'ts':
    case 'tsx':
      return <FileCode className={`${iconClass} text-blue-500`} />;
    case 'js':
    case 'jsx':
      return <FileCode className={`${iconClass} text-yellow-500`} />;
    case 'json':
      return <FileJson className={`${iconClass} text-green-500`} />;
    case 'md':
    case 'txt':
      return <FileText className={`${iconClass} text-gray-500`} />;
    case 'py':
      return <FileCode className={`${iconClass} text-blue-400`} />;
    case 'css':
    case 'scss':
    case 'sass':
      return <FileCode className={`${iconClass} text-pink-500`} />;
    default:
      return <File className={`${iconClass} text-gray-400`} />;
  }
};

// Calculate relevance percentage from score (assuming score is 0-100)
const getRelevancePercentage = (score?: number): number => {
  if (score === undefined) return 50;
  return Math.min(100, Math.max(0, score));
};

// Get color for percentage text
const getPercentageTextColor = (percentage: number): string => {
  if (percentage >= 100) return 'text-green-600';
  if (percentage >= 40) return 'text-blue-600';
  return 'text-gray-500';
};


// Extract filename from path
const getFileName = (path: string): string => {
  const parts = path.split('/');
  return parts[parts.length - 1];
};

// Extract directory path from full path (excluding filename)
const getDirectoryPath = (path: string): string => {
  const parts = path.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
};

// Component for displaying file with two lines: filename on top, path below
interface TwoLineFileDisplayProps {
  path: string;
}

const TwoLineFileDisplay: React.FC<TwoLineFileDisplayProps> = ({ path }) => {
  const [copied, setCopied] = useState(false);
  const fileName = getFileName(path);
  const dirPath = getDirectoryPath(path);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  }, [path]);

  return (
    <div
      className="flex-1 min-w-0 relative cursor-pointer group"
      onClick={handleCopy}
      title={path}
    >
      {/* Filename - bold */}
      <div className="font-mono text-sm font-semibold text-gray-900 truncate group-hover:text-indigo-600 transition-colors">
        {fileName}
      </div>
      {/* Directory path - dimmed, middle-truncated */}
      {dirPath && (
        <div
          className="font-mono text-xs text-gray-400 overflow-hidden whitespace-nowrap"
          style={{
            direction: 'rtl',
            textAlign: 'left',
            textOverflow: 'ellipsis',
          }}
        >
          <bdi>{dirPath}</bdi>
        </div>
      )}
      {/* Copy feedback */}
      {copied && (
        <div className="absolute left-0 bottom-full mb-1 z-50 px-2 py-1 bg-green-600 text-white text-xs rounded shadow-lg flex items-center gap-1">
          <Check className="w-3 h-3" />
          <span>Copied!</span>
        </div>
      )}
    </div>
  );
};

export const SmartFileSelection: React.FC<SmartFileSelectionProps> = ({ smartSelection, totalTokens, costEstimate }) => {
  const { maxScore } = useMemo(() => {
    const max = Math.max(...smartSelection.map(f => f.score || 0), 1);
    return { maxScore: max };
  }, [smartSelection]);

  if (smartSelection.length === 0) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Status bar header */}
      <div className="px-4 py-3 flex items-center justify-between border-b border-gray-200 bg-gray-50">
        <div className="flex items-center gap-2">
          <FolderOpen className="w-5 h-5 text-indigo-500" />
          <span className="font-medium text-gray-900">
            Context ({smartSelection.length} files)
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {totalTokens ? (
            <span className="text-gray-600">
              <span className="font-medium text-gray-700">
                {(totalTokens / 1000).toFixed(0)}k
              </span>{' '}
              tokens
            </span>
          ) : (
            <span className="text-gray-400 italic">--</span>
          )}
          <span className="text-gray-300">•</span>
          {costEstimate ? (
            <span className="font-semibold text-gray-900">
              ${costEstimate.toFixed(2)}
            </span>
          ) : (
            <span className="text-gray-400 italic">--</span>
          )}
        </div>
      </div>

      {/* Scrollable file list */}
      <div className="flex-1 overflow-y-auto divide-y divide-gray-100 scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-gray-100 hover:scrollbar-thumb-gray-400" style={{
        scrollbarWidth: 'thin',
        scrollbarColor: '#d1d5db #f3f4f6'
      }}>
        {smartSelection.map((file, idx) => {
          const relevance = getRelevancePercentage(file.score ? (file.score / maxScore) * 100 : 50);
          const percentageColor = getPercentageTextColor(relevance);
          // Only show 'manual' pill, hide 'auto' pill
          const showManualPill = file.source === 'manual';

          return (
            <div
              key={idx}
              className="px-4 py-2 flex items-start gap-3 hover:bg-gray-50 transition-colors"
            >
              {/* File icon - aligned to top */}
              <div className="pt-0.5">
                {getFileIcon(file.path)}
              </div>

              {/* Two-line file display */}
              <TwoLineFileDisplay path={file.path} />

              {/* Right side: pills and percentage (no progress bar) */}
              <div className="flex items-start gap-3 flex-shrink-0">
                {/* Manual pill (only shown if source is manual) */}
                {showManualPill && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 mt-0.5">
                    manual
                  </span>
                )}

                {/* Percentage only - no bar */}
                <span className={`text-xs font-medium ${percentageColor} w-10 text-right`}>
                  {Math.round(relevance)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

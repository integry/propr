import React, { useMemo } from 'react';
import { FileCode, FileText, FileJson, File, FolderOpen } from 'lucide-react';
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

// Get color for relevance bar
const getRelevanceColor = (percentage: number): string => {
  if (percentage >= 70) return 'bg-green-500';
  if (percentage >= 40) return 'bg-blue-500';
  return 'bg-gray-400';
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
          const relevanceColor = getRelevanceColor(relevance);

          return (
            <div
              key={idx}
              className="px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                {getFileIcon(file.path)}
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-sm text-gray-900 block truncate">
                    {file.path}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  file.source === 'manual'
                    ? 'bg-gray-200 text-gray-600'
                    : 'bg-green-100 text-green-700'
                }`}>
                  {file.source === 'auto' ? 'auto' : 'manual'}
                </span>

                {/* Relevance bar */}
                <div className="flex items-center gap-2 w-28">
                  <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${relevanceColor}`}
                      style={{ width: `${relevance}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-500 w-8 text-right">
                    {Math.round(relevance)}%
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

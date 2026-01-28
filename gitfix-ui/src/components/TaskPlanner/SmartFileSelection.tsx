import React, { useState, useMemo } from 'react';
import { ChevronDown, ChevronUp, FileCode, FileText, FileJson, File, FolderOpen } from 'lucide-react';
import { PreviewResult } from '../../api/gitfixApi';

interface SmartFileSelectionProps {
  smartSelection: PreviewResult['smartSelection'];
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

export const SmartFileSelection: React.FC<SmartFileSelectionProps> = ({ smartSelection }) => {
  // Auto-expand when files are selected
  const [isExpanded, setIsExpanded] = useState(true);

  const { autoCount, manualCount, maxScore } = useMemo(() => {
    const auto = smartSelection.filter(f => f.source === 'auto').length;
    const manual = smartSelection.filter(f => f.source === 'manual').length;
    const max = Math.max(...smartSelection.map(f => f.score || 0), 1);
    return { autoCount: auto, manualCount: manual, maxScore: max };
  }, [smartSelection]);

  if (smartSelection.length === 0) return null;

  const displayFiles = isExpanded ? smartSelection : smartSelection.slice(0, 0);

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      {/* Collapsible header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors"
      >
        <div className="flex items-center gap-3">
          <FolderOpen className="w-5 h-5 text-indigo-500" />
          <span className="font-medium text-gray-900">
            {smartSelection.length} files selected
          </span>
          {autoCount > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">
              {autoCount} auto-selected
            </span>
          )}
          {manualCount > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
              {manualCount} manual
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm text-indigo-600 font-medium">
          {isExpanded ? (
            <>
              <span>Hide files</span>
              <ChevronUp className="w-4 h-4" />
            </>
          ) : (
            <>
              <span>Review files</span>
              <ChevronDown className="w-4 h-4" />
            </>
          )}
        </div>
      </button>

      {/* Expandable file list */}
      {isExpanded && (
        <div className="max-h-80 overflow-y-auto divide-y divide-gray-100">
          {displayFiles.map((file, idx) => {
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
                    {file.reason && (
                      <span className="text-xs text-gray-500 block truncate" title={file.reason}>
                        {file.reason}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    file.source === 'manual'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-green-100 text-green-700'
                  }`}>
                    {file.source}
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
      )}
    </div>
  );
};

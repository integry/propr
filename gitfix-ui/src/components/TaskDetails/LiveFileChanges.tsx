import React, { useState, useEffect } from 'react';
import { FileChangesResponse, getFileChanges } from '../../api/fileChangesApi';
import FileTree from './FileTree';
import DiffViewer from './DiffViewer';
import { GitBranch, RefreshCw, AlertCircle, Plus, Minus } from 'lucide-react';

interface LiveFileChangesProps {
  taskId: string;
  isActive: boolean;
  onShowDiff?: (showingDiff: boolean) => void;
}

const LiveFileChanges: React.FC<LiveFileChangesProps> = ({
  taskId,
  isActive,
  onShowDiff
}) => {
  const [fileChanges, setFileChanges] = useState<FileChangesResponse | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initial fetch and polling
  useEffect(() => {
    let isMounted = true;
    let hasReceivedData = false;

    const fetchData = async () => {
      try {
        const data = await getFileChanges(taskId);
        if (isMounted) {
          setFileChanges(data);
          setError(null);
          hasReceivedData = true;
        }
      } catch (err) {
        if (isMounted) {
          // Only set error on first fetch failure, not subsequent polls
          if (!hasReceivedData) {
            setError((err as Error).message);
          }
          console.error('Error fetching file changes:', err);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    setIsLoading(true);
    setError(null);
    setFileChanges(null);
    setSelectedFilePath(null);
    fetchData();

    // Poll every 2 seconds when active
    let interval: NodeJS.Timeout | undefined;
    if (isActive) {
      interval = setInterval(fetchData, 2000);
    }

    return () => {
      isMounted = false;
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [taskId, isActive]);

  // Notify parent when diff view state changes
  useEffect(() => {
    onShowDiff?.(selectedFilePath !== null);
  }, [selectedFilePath, onShowDiff]);

  const handleSelectFile = (path: string) => {
    setSelectedFilePath(path);
  };

  const handleCloseDiff = () => {
    setSelectedFilePath(null);
  };

  const selectedFile = selectedFilePath
    ? fileChanges?.files.find((f) => f.path === selectedFilePath)
    : null;

  // For finished tasks without file changes data, hide the section entirely
  // This includes loading, error, and empty states for finished tasks
  if (!isActive && (!fileChanges || fileChanges.files.length === 0)) {
    return null;
  }

  // Loading state (only for active tasks)
  if (isLoading && !fileChanges) {
    return (
      <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-center gap-2 text-gray-600">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading file changes...</span>
        </div>
      </div>
    );
  }

  // Error state (only show for active tasks if we never got data)
  if (error && !fileChanges) {
    return (
      <div className="mb-6 p-4 bg-red-50 rounded-lg border border-red-200">
        <div className="flex items-center gap-2 text-red-600">
          <AlertCircle className="h-4 w-4" />
          <span className="text-sm">Failed to load file changes: {error}</span>
        </div>
      </div>
    );
  }

  // No changes yet - show placeholder for active tasks (finished tasks already handled above)
  if (!fileChanges || fileChanges.files.length === 0) {
    return (
      <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
        <h4 className="text-gray-700 font-semibold flex items-center gap-2 mb-2">
          <GitBranch className="h-5 w-5 text-gray-500" />
          Live File Changes
          <span className="relative flex h-2 w-2 ml-1">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-gray-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-gray-500"></span>
          </span>
        </h4>
        <p className="text-sm text-gray-500 italic">No files changed yet</p>
      </div>
    );
  }

  return (
    <div className="mb-6">
      {/* Main panel showing file tree */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        {/* Header */}
        <div className="p-3 border-b border-gray-200 bg-gray-50 rounded-t-lg">
          <div className="flex items-center justify-between">
            <h4 className="text-gray-800 font-semibold flex items-center gap-2">
              <GitBranch className="h-5 w-5 text-purple-500" />
              {isActive ? 'Live File Changes' : 'File Changes'}
              {isActive && (
                <span className="relative flex h-2 w-2 ml-1">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500"></span>
                </span>
              )}
              <span className="text-sm font-normal text-gray-500">
                ({fileChanges.files.length} file{fileChanges.files.length !== 1 ? 's' : ''})
              </span>
            </h4>
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <Plus className="h-3 w-3 text-green-600" />
                <span className="text-green-600 font-medium">{fileChanges.totalLinesAdded}</span>
              </span>
              <span className="flex items-center gap-1">
                <Minus className="h-3 w-3 text-red-600" />
                <span className="text-red-600 font-medium">{fileChanges.totalLinesRemoved}</span>
              </span>
            </div>
          </div>
        </div>

        {/* File Tree */}
        <div className="p-2 max-h-64 overflow-y-auto">
          <FileTree
            files={fileChanges.files}
            selectedFile={selectedFilePath}
            onSelectFile={handleSelectFile}
          />
        </div>
      </div>

      {/* Diff Viewer (shown when a file is selected) */}
      {selectedFile && (
        <div className="mt-4 h-96">
          <DiffViewer file={selectedFile} onClose={handleCloseDiff} />
        </div>
      )}
    </div>
  );
};

export default LiveFileChanges;

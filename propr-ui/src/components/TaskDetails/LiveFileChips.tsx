import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { RefreshCw, AlertCircle, Plus, Minus, Trash2, ArrowRight } from 'lucide-react';
import DiffViewer from './DiffViewer';
import { FileChange, FileChangesResponse, getFileChanges } from '../../api/fileChangesApi';
import { useSocket } from '../../contexts/useSocket';
import { TaskUpdatePayload } from '@propr/shared';

interface LiveFileChipsProps {
  taskId: string;
  isActive: boolean;
}

// Get status indicator for file change
const getStatusIndicator = (status: FileChange['status']) => {
  switch (status) {
    case 'added':
      return <Plus className="h-3 w-3 text-green-500 flex-shrink-0" />;
    case 'deleted':
      return <Trash2 className="h-3 w-3 text-red-500 flex-shrink-0" />;
    case 'renamed':
      return <ArrowRight className="h-3 w-3 text-yellow-500 flex-shrink-0" />;
    default:
      return null;
  }
};

// Get background color class based on status
const getChipBgClass = (status: FileChange['status'], isSelected: boolean) => {
  if (isSelected) {
    return 'bg-primary-100 border-primary-300';
  }
  switch (status) {
    case 'added':
      return 'bg-green-50 border-green-200 hover:bg-green-100';
    case 'deleted':
      return 'bg-red-50 border-red-200 hover:bg-red-100';
    case 'renamed':
      return 'bg-yellow-50 border-yellow-200 hover:bg-yellow-100';
    default:
      return 'bg-gray-50 border-gray-200 hover:bg-gray-100';
  }
};

const LiveFileChips: React.FC<LiveFileChipsProps> = ({ taskId, isActive }) => {
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { subscribeToTask, unsubscribeFromTask, onTaskUpdate, isConnected } = useSocket();

  // Fetch file changes
  const fetchFileChanges = useCallback(async () => {
    try {
      const response: FileChangesResponse = await getFileChanges(taskId);
      setFileChanges(response.files);
      setError(null);
    } catch (err) {
      // Don't show error for 404 (no changes yet) during active tasks
      if ((err as Error).message?.includes('404') && isActive) {
        setFileChanges([]);
        setError(null);
      } else {
        setError((err as Error).message || 'Failed to load file changes');
      }
    } finally {
      setIsLoading(false);
    }
  }, [taskId, isActive]);

  // Handle task update from WebSocket - refetch file changes
  const handleTaskUpdate = useCallback((payload: TaskUpdatePayload) => {
    if (payload.taskId !== taskId) return;

    console.log('[LiveFileChips] Received task update, refreshing file changes:', payload);
    fetchFileChanges();
  }, [taskId, fetchFileChanges]);

  // Initial fetch
  useEffect(() => {
    fetchFileChanges();
  }, [fetchFileChanges]);

  // Subscribe to WebSocket events for this task
  useEffect(() => {
    if (!isActive || !isConnected) return;

    // Subscribe to this specific task's room
    subscribeToTask(taskId);

    // Listen for task updates
    const unsubscribe = onTaskUpdate(handleTaskUpdate);

    return () => {
      unsubscribeFromTask(taskId);
      unsubscribe();
    };
  }, [taskId, isActive, isConnected, subscribeToTask, unsubscribeFromTask, onTaskUpdate, handleTaskUpdate]);

  // Get selected file object
  const selectedFile = useMemo(() => {
    if (!selectedFilePath) return null;
    return fileChanges.find(f => f.path === selectedFilePath) || null;
  }, [selectedFilePath, fileChanges]);

  // Calculate totals
  const totals = useMemo(() => {
    return fileChanges.reduce(
      (acc, file) => ({
        files: acc.files + 1,
        added: acc.added + file.linesAdded,
        removed: acc.removed + file.linesRemoved
      }),
      { files: 0, added: 0, removed: 0 }
    );
  }, [fileChanges]);

  // Handle file selection
  const handleSelectFile = (filePath: string) => {
    setSelectedFilePath(filePath === selectedFilePath ? null : filePath);
  };

  // Get just the filename from the path
  const getFileName = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1];
  };

  // Don't render if no file changes and not loading
  if (!isLoading && fileChanges.length === 0 && !error) {
    return null;
  }

  return (
    <div className="relative border-t border-gray-100 pt-4">
      {/* Header - Utility Header style */}
      <div className="flex items-center justify-between mb-3 mt-8">
        <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 flex items-center gap-2 m-0">
          FILES CHANGED
          {isActive && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500"></span>
            </span>
          )}
        </h4>
        {fileChanges.length > 0 && (
          <div className="flex items-center gap-3 text-xs">
            <span className="text-gray-500">
              {totals.files} file{totals.files !== 1 ? 's' : ''}
            </span>
            <span className="flex items-center text-green-600 font-mono">
              <Plus className="h-3 w-3" />
              {totals.added}
            </span>
            <span className="flex items-center text-red-500 font-mono">
              <Minus className="h-3 w-3" />
              {totals.removed}
            </span>
          </div>
        )}
      </div>

      {/* Content */}
      {isLoading && fileChanges.length === 0 ? (
        <div className="flex items-center gap-2 text-gray-500 py-2 text-sm">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span>Loading...</span>
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-red-600 py-2 text-sm">
          <AlertCircle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      ) : (
        /* Dense list of monospace code chips */
        <div className="flex flex-wrap gap-1.5">
          {fileChanges.map(file => {
            const isSelected = selectedFilePath === file.path;
            return (
              <button
                key={file.path}
                onClick={() => handleSelectFile(file.path)}
                className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-[11px] font-mono transition-colors cursor-pointer ${getChipBgClass(file.status, isSelected)}`}
                title={file.path}
              >
                {getStatusIndicator(file.status)}
                <span className="truncate max-w-[150px]">{getFileName(file.path)}</span>
                {(file.linesAdded > 0 || file.linesRemoved > 0) && (
                  <span className="flex items-center gap-0.5 text-[10px] opacity-70">
                    {file.linesAdded > 0 && <span className="text-green-600">+{file.linesAdded}</span>}
                    {file.linesRemoved > 0 && <span className="text-red-500">-{file.linesRemoved}</span>}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Diff Viewer Overlay */}
      {selectedFile && (
        <>
          {/* Semi-transparent backdrop */}
          <div
            className="fixed inset-0 bg-black/20 z-40"
            onClick={() => setSelectedFilePath(null)}
          />
          {/* Diff viewer overlay - adjusted for new 30% left pane */}
          <div className="fixed top-20 left-[calc(30%+2rem)] right-4 bottom-4 z-50 bg-white rounded-lg shadow-2xl border border-gray-200 overflow-hidden">
            <DiffViewer
              file={selectedFile}
              onClose={() => setSelectedFilePath(null)}
            />
          </div>
        </>
      )}
    </div>
  );
};

export default LiveFileChips;

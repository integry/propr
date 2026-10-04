import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { RefreshCw, AlertCircle, Plus, Minus, File, FilePlus, FileSymlink, FileX } from 'lucide-react';
import DiffViewer from './DiffViewer';
import { FileChange, FileChangesResponse, getFileChanges } from '../../api/fileChangesApi';
import { useSocket } from '../../contexts/useSocket';
import { TaskUpdatePayload } from '@propr/shared';
import { useLiveRefreshScheduler } from '../../hooks/useLiveRefreshScheduler';
import { useCurrentUser } from '../../contexts/AuthContext';
import { getDesktopSocketConfigurationKey } from '../../api/apiClient';

interface LiveFileChipsProps {
  taskId: string;
  isActive: boolean;
}

// A file-tree icon that also carries the change: added, deleted or renamed files are tinted.
const getFileIcon = (status: FileChange['status']) => {
  const className = 'h-3.5 w-3.5 flex-shrink-0';
  switch (status) {
    case 'added':
      return <FilePlus className={`${className} text-green-600`} aria-label="Added" />;
    case 'deleted':
      return <FileX className={`${className} text-red-500`} aria-label="Deleted" />;
    case 'renamed':
      return <FileSymlink className={`${className} text-amber-600`} aria-label="Renamed" />;
    default:
      return <File className={`${className} text-slate-400`} aria-hidden="true" />;
  }
};

const LiveFileChips: React.FC<LiveFileChipsProps> = ({ taskId, isActive }) => {
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const currentUser = useCurrentUser();
  const { onTaskUpdate, isConnected } = useSocket();
  const activeTaskIdRef = useRef(taskId);
  activeTaskIdRef.current = taskId;
  const requestScopeKey = `${getDesktopSocketConfigurationKey()}\0${currentUser?.id ?? ''}\0${taskId}`;
  const activeRequestScopeRef = useRef(requestScopeKey);
  activeRequestScopeRef.current = requestScopeKey;

  // Fetch file changes
  const fetchFileChanges = useCallback(async () => {
    const requestedScope = requestScopeKey;
    try {
      const response: FileChangesResponse = await getFileChanges(taskId);
      if (activeRequestScopeRef.current !== requestedScope) return;
      setFileChanges(response.files);
      setError(null);
    } catch (err) {
      if (activeRequestScopeRef.current !== requestedScope) return;
      // Don't show error for 404 (no changes yet) during active tasks
      if ((err as Error).message?.includes('404') && isActive) {
        setFileChanges([]);
        setError(null);
      } else {
        setError((err as Error).message || 'Failed to load file changes');
      }
    } finally {
      if (activeRequestScopeRef.current === requestedScope) setIsLoading(false);
    }
  }, [requestScopeKey, taskId, isActive]);

  const scheduleFileChangesRefresh = useLiveRefreshScheduler({
    isConnected,
    refresh: fetchFileChanges,
    scopeKey: requestScopeKey,
  });

  // Handle task update from WebSocket - refetch file changes
  const handleTaskUpdate = useCallback((payload: TaskUpdatePayload) => {
    if (payload.taskId !== activeTaskIdRef.current) return;

    console.log('[LiveFileChips] Received task update, refreshing file changes:', payload);
    scheduleFileChangesRefresh();
  }, [scheduleFileChangesRefresh]);

  // Initial fetch
  useEffect(() => {
    setIsLoading(true);
    setError(null);
    setSelectedFilePath(null);
    void scheduleFileChangesRefresh.refreshNow();
  }, [requestScopeKey, taskId, scheduleFileChangesRefresh]);

  // Subscribe to WebSocket events for this task
  useEffect(() => {
    if (!isActive || !isConnected) return;

    // useTaskData owns the detail route's task-room subscription. This child
    // only listens to the shared event fan-out, avoiding a duplicate room
    // subscription and an early unsubscribe when the task becomes terminal.
    const unsubscribe = onTaskUpdate(handleTaskUpdate);

    return () => {
      unsubscribe();
    };
  }, [isActive, isConnected, onTaskUpdate, handleTaskUpdate]);

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

  const sortedFiles = useMemo(() => [...fileChanges].sort((a, b) =>
    (b.linesAdded + b.linesRemoved) - (a.linesAdded + a.linesRemoved) || a.path.localeCompare(b.path)
  ), [fileChanges]);

  const commonDirectory = useMemo(() => {
    const parts = sortedFiles[0]?.path.split('/').slice(0, -1) ?? [];
    for (const file of sortedFiles.slice(1)) {
      const directory = file.path.split('/').slice(0, -1);
      while (parts.length && !parts.every((part, index) => part === directory[index])) {
        parts.pop();
      }
    }
    return parts.length ? `${parts.join('/')}/` : '';
  }, [sortedFiles]);
  const directoryParts = commonDirectory.split('/').filter(Boolean);
  const directoryLabel = directoryParts.length > 3
    ? `${directoryParts[0]}/…/${directoryParts[directoryParts.length - 1]}/`
    : commonDirectory;

  // Don't render if no file changes and not loading
  if (!isLoading && fileChanges.length === 0 && !error) {
    return null;
  }

  return (
    <div className="relative border-t border-gray-100 pt-2">
      {/* Header - Utility Header style */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2 mt-4">
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
        /*
         * A file tree, not a form field: the shared folder as a quiet label and
         * the files beneath it as plain rows. A bounded list keeps large
         * changesets from taking over the timeline.
         */
        <div role="region" aria-label="Changed files" tabIndex={0} className="max-h-48 overflow-y-auto overscroll-contain rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">
          {commonDirectory && (
            <div className="sticky top-0 bg-white px-2 py-0.5 font-mono text-xs text-slate-400 break-all" title={commonDirectory}>
              {directoryLabel}
            </div>
          )}
          <div className={commonDirectory ? 'pl-2' : ''}>
            {sortedFiles.map(file => {
              const isSelected = selectedFilePath === file.path;
              const relativePath = file.path.slice(commonDirectory.length);
              const parentDirectory = relativePath.split('/').slice(0, -1).map(part => `${part}/`).join('');
              return (
                <button
                  key={file.path}
                  onClick={() => handleSelectFile(file.path)}
                  aria-label={`View diff for ${file.path}`}
                  className={`flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left font-mono text-xs transition-colors ${isSelected ? 'bg-slate-100' : 'hover:bg-slate-50'}`}
                  title={file.path}
                >
                  {getFileIcon(file.status)}
                  <span className="min-w-0 flex-1 break-all">
                    {parentDirectory && <span className="text-slate-400">{parentDirectory}</span>}
                    <span className="text-slate-700">{file.path.split('/').pop()}</span>
                  </span>
                  {(file.linesAdded > 0 || file.linesRemoved > 0) && (
                    <span className="flex flex-shrink-0 items-center gap-1 text-[11px] tabular-nums">
                      {file.linesAdded > 0 && <span className="text-green-600">+{file.linesAdded}</span>}
                      {file.linesRemoved > 0 && <span className="text-red-500">-{file.linesRemoved}</span>}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!error && fileChanges.length > 5 && (
        <p className="mt-1.5 text-[10px] text-slate-500">Most modified first · Scroll to view all {fileChanges.length} files</p>
      )}

      {/* Diff Viewer Overlay */}
      {selectedFile && (
        <>
          {/* Semi-transparent backdrop */}
          <div
            className="fixed inset-0 bg-black/20 z-40"
            onClick={() => setSelectedFilePath(null)}
          />
          {/* Diff viewer overlay - full width on mobile, adjusted for 30% left pane on desktop */}
          <div className="fixed top-4 left-4 right-4 bottom-4 lg:top-20 lg:left-[calc(30%+2rem)] z-50 bg-white rounded-lg shadow-2xl border border-gray-200 overflow-hidden">
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

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { GitBranch, RefreshCw, AlertCircle, Plus, Minus } from 'lucide-react';
import FileTree from './FileTree';
import DiffViewer from './DiffViewer';
import { FileChange, FileChangesResponse, getFileChanges } from '../../api/fileChangesApi';

interface LiveFileChangesProps {
  taskId: string;
  isActive: boolean;
}

const LiveFileChanges: React.FC<LiveFileChangesProps> = ({ taskId, isActive }) => {
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // Initial fetch and polling
  useEffect(() => {
    fetchFileChanges();

    if (isActive) {
      const interval = setInterval(fetchFileChanges, 2000);
      return () => clearInterval(interval);
    }
  }, [fetchFileChanges, isActive]);

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

  return (
    <div className="relative">
      {/* File Tree Panel - takes full width of left column */}
      <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-purple-900 flex items-center gap-2 m-0">
            <GitBranch className="h-5 w-5" />
            <span className="flex items-center gap-2">
              {isActive ? 'Live File Changes' : 'File Changes'}
              {isActive && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500"></span>
                </span>
              )}
            </span>
          </h4>
          {fileChanges.length > 0 && (
            <div className="flex items-center gap-4 text-sm">
              <span className="text-gray-600">
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
          <div className="flex items-center gap-2 text-purple-600 py-4">
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span>Loading file changes...</span>
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 text-red-600 py-4">
            <AlertCircle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        ) : fileChanges.length === 0 ? (
          <div className="text-purple-700 py-2 text-sm italic">
            {isActive ? 'No file changes yet. Changes will appear here as files are modified.' : 'No files were changed during this task.'}
          </div>
        ) : (
          <div className="bg-white rounded border border-purple-100 overflow-hidden">
            <FileTree
              files={fileChanges}
              selectedFile={selectedFilePath}
              onSelectFile={handleSelectFile}
            />
          </div>
        )}
      </div>

      {/* Diff Viewer Overlay - absolutely positioned to the right of the file tree */}
      {selectedFile && (
        <>
          {/* Semi-transparent backdrop */}
          <div
            className="fixed inset-0 bg-black/20 z-40"
            onClick={() => setSelectedFilePath(null)}
          />
          {/* Diff viewer overlay */}
          <div className="fixed top-20 left-[calc(33.333%+2rem)] right-4 bottom-4 z-50 bg-white rounded-lg shadow-2xl border border-gray-200 overflow-hidden">
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

export default LiveFileChanges;

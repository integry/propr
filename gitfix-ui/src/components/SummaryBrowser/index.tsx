import React, { useState, useEffect, useCallback } from 'react';
import { Folder, AlertCircle, Loader2, GitCommit } from 'lucide-react';
import { motion } from 'framer-motion';
import {
  getDirectoryTree,
  getIndexingStatus,
  type SummaryEntry,
  type IndexingStatusResponse,
} from '../../api/summaryApi';
import TreeNode from './TreeNode';
import SummaryPanel from './SummaryPanel';

const shortenHash = (hash: string | null): string => {
  if (!hash) return '';
  return hash.substring(0, 7);
};

const truncateMessage = (message: string | null, maxLength: number = 60): string => {
  if (!message) return '';
  const firstLine = message.split('\n')[0];
  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.substring(0, maxLength - 3) + '...';
};

export interface SummaryBrowserProps {
  owner: string;
  repo: string;
}

export interface TreeNodeState {
  expanded: boolean;
  children: SummaryEntry[] | null;
  loading: boolean;
}

const SummaryBrowser: React.FC<SummaryBrowserProps> = ({ owner, repo }) => {
  const [indexingStatus, setIndexingStatus] = useState<IndexingStatusResponse | null>(null);
  const [rootEntries, setRootEntries] = useState<SummaryEntry[]>([]);
  const [nodeStates, setNodeStates] = useState<Record<string, TreeNodeState>>({});
  const [selectedEntry, setSelectedEntry] = useState<SummaryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch indexing status and root entries on mount
  useEffect(() => {
    async function fetchInitialData() {
      setLoading(true);
      setError(null);
      try {
        const status = await getIndexingStatus(owner, repo);
        setIndexingStatus(status);

        if (status.indexed) {
          const tree = await getDirectoryTree(owner, repo, '');
          setRootEntries(tree.entries);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load repository summaries');
      } finally {
        setLoading(false);
      }
    }
    fetchInitialData();
  }, [owner, repo]);

  // Handle expanding/collapsing a directory
  const toggleDirectory = useCallback(
    async (entry: SummaryEntry) => {
      const currentState = nodeStates[entry.path] || {
        expanded: false,
        children: null,
        loading: false,
      };

      if (currentState.expanded) {
        // Collapse
        setNodeStates((prev) => ({
          ...prev,
          [entry.path]: { ...currentState, expanded: false },
        }));
      } else {
        // Expand - fetch children if not already loaded
        if (currentState.children === null) {
          setNodeStates((prev) => ({
            ...prev,
            [entry.path]: { ...currentState, loading: true, expanded: true },
          }));

          try {
            const tree = await getDirectoryTree(owner, repo, entry.path);
            setNodeStates((prev) => ({
              ...prev,
              [entry.path]: { expanded: true, children: tree.entries, loading: false },
            }));
          } catch {
            setNodeStates((prev) => ({
              ...prev,
              [entry.path]: { expanded: false, children: null, loading: false },
            }));
          }
        } else {
          setNodeStates((prev) => ({
            ...prev,
            [entry.path]: { ...currentState, expanded: true },
          }));
        }
      }
    },
    [owner, repo, nodeStates]
  );

  // Handle selecting an entry
  const handleSelectEntry = useCallback(
    (entry: SummaryEntry) => {
      setSelectedEntry(entry);
      if (entry.entryType === 'directory') {
        toggleDirectory(entry);
      }
    },
    [toggleDirectory]
  );

  // Loading state
  if (loading) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex items-center justify-center p-8"
      >
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        <span className="ml-2 text-gray-500">Loading repository summaries...</span>
      </motion.div>
    );
  }

  // Error state
  if (error) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-3 p-6 bg-red-50 border border-red-200 rounded-lg"
      >
        <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
        <div>
          <p className="font-medium text-red-700">Failed to load summaries</p>
          <p className="text-sm text-red-600">{error}</p>
        </div>
      </motion.div>
    );
  }

  // Not indexed state
  if (!indexingStatus?.indexed) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="p-6 bg-gray-50 border border-gray-200 rounded-lg text-center"
      >
        <Folder className="w-12 h-12 text-gray-300 mx-auto mb-3" />
        <h3 className="font-medium text-gray-700 mb-1">Repository Not Indexed</h3>
        <p className="text-sm text-gray-500">
          No file summaries are available for {owner}/{repo}. Enable summarization in Settings to
          generate summaries.
        </p>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="border border-gray-200 rounded-lg bg-white overflow-hidden shadow-sm"
    >
      {/* Header */}
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
        <h3 className="font-semibold text-gray-800">
          {owner}/{repo}
        </h3>
        <p className="text-xs text-gray-500 mt-0.5">
          {indexingStatus.fileCount} files, {indexingStatus.directoryCount} directories indexed
        </p>
        {indexingStatus.lastIndexedHash && (
          <div
            className="flex items-center gap-2 mt-1.5"
            title={indexingStatus.lastIndexedCommitMessage || undefined}
          >
            <GitCommit className="w-3.5 h-3.5 text-gray-400" />
            <a
              href={`https://github.com/${owner}/${repo}/commit/${indexingStatus.lastIndexedHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded hover:bg-gray-200 hover:text-blue-600 transition-colors"
            >
              {shortenHash(indexingStatus.lastIndexedHash)}
            </a>
            {indexingStatus.lastIndexedCommitMessage && (
              <span className="text-xs text-gray-500 truncate">
                {truncateMessage(indexingStatus.lastIndexedCommitMessage)}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col md:flex-row">
        {/* Tree Panel */}
        <div className="md:w-1/2 border-b md:border-b-0 md:border-r border-gray-200 md:max-h-[calc(100vh-200px)] overflow-auto">
          <div className="p-2">
            {rootEntries.length === 0 ? (
              <p className="text-sm text-gray-500 p-4 text-center">No entries found</p>
            ) : (
              rootEntries.map((entry) => (
                <TreeNode
                  key={entry.path}
                  entry={entry}
                  depth={0}
                  nodeStates={nodeStates}
                  selectedPath={selectedEntry?.path || null}
                  onSelect={handleSelectEntry}
                />
              ))
            )}
          </div>
        </div>

        {/* Summary Detail Panel */}
        <SummaryPanel selectedEntry={selectedEntry} />
      </div>
    </motion.div>
  );
};

export default SummaryBrowser;

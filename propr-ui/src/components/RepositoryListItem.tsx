import React, { useState } from 'react';
import { Github } from 'lucide-react';
import { IndexingStatusIndicator } from './IndexingStatusIndicator';
import { DeleteRepoDialog } from './DeleteRepoDialog';
import { RepositoryIndexingStatus, MonitoredRepo } from '../api/proprApi';
import { getRepoStatusKey } from '../api/repoIndexingApi';

// --- Icons ---

const TrashIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const GitBranchIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 3v12M6 21a3 3 0 100-6 3 3 0 000 6zM18 9a3 3 0 100-6 3 3 0 000 6zM6 15a3 3 0 00-3 3M18 6a9 9 0 01-9 9" />
  </svg>
);

// Ghost Monospace chip - subdued styling for metadata (no background)
const GhostMonoChip: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <code className={`text-[10px] font-mono text-slate-400 ${className}`}>
    {children}
  </code>
);

interface RepositoryListItemProps {
  repo: MonitoredRepo;
  indexingStatuses: Record<string, RepositoryIndexingStatus>;
  onToggle: (repoId: string) => void;
  onRemove: (repoId: string) => void | Promise<void>;
  onStopIndexing: (repoName: string, baseBranch?: string) => void;
  onReindex: (repoName: string, baseBranch?: string) => void;
  isSelected?: boolean;
  onSelect?: (repoId: string) => void;
}

export const RepositoryListItem: React.FC<RepositoryListItemProps> = ({
  repo,
  indexingStatuses,
  onToggle,
  onRemove,
  onStopIndexing,
  onReindex,
  isSelected = false,
  onSelect,
}) => {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteClick = () => {
    setIsDeleteDialogOpen(true);
  };

  const handleDeleteClose = () => {
    setIsDeleteDialogOpen(false);
  };

  const handleDeleteConfirm = async () => {
    setIsDeleting(true);
    try {
      await onRemove(repo.id);
    } finally {
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  return (
    <div
      className={`border-b border-slate-50 cursor-pointer transition-colors relative group ${
        isSelected
          ? 'bg-white'
          : 'hover:bg-slate-50/30'
      }`}
      onClick={() => onSelect?.(repo.id)}
    >
      {/* Solid 3px Teal vertical rail for active state */}
      <div className={`absolute left-0 top-0 bottom-0 w-[3px] transition-colors ${
        isSelected ? 'bg-teal-500' : 'bg-transparent'
      }`} />
      {/* --- Repository Row: Full-width, gutter-to-gutter --- */}
      <div className="flex items-center justify-between py-3 pl-4 pr-3">
        <div className={`flex items-center gap-2 min-w-0 ${repo.enabled ? 'opacity-100' : 'opacity-50'}`}>
          {/* Repository name - bold slate-900 */}
          {repo.alias ? (
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-bold text-slate-900 truncate">{repo.alias}</span>
              <GhostMonoChip>{repo.name}</GhostMonoChip>
            </div>
          ) : (
            <span className="font-bold text-slate-900 truncate">{repo.name}</span>
          )}
          {/* Branch - Ghost Monospace style */}
          {repo.baseBranch && (
            <span className="inline-flex items-center gap-1 flex-shrink-0">
              <GitBranchIcon className="w-3 h-3 text-slate-300" />
              <GhostMonoChip>{repo.baseBranch}</GhostMonoChip>
            </span>
          )}
          <IndexingStatusIndicator
            status={indexingStatuses[getRepoStatusKey(repo.name, repo.baseBranch)]}
            onStop={() => onStopIndexing(repo.name, repo.baseBranch)}
            onReindex={() => onReindex(repo.name, repo.baseBranch)}
          />
        </div>

        {/* Icons - ghosted by default, visible on hover */}
        <div className="flex items-center gap-1.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          {/* Toggle Switch - ghosted appearance */}
          <label className="relative inline-flex items-center cursor-pointer opacity-40 group-hover:opacity-100 transition-opacity">
            <input
              type="checkbox"
              checked={repo.enabled}
              onChange={() => onToggle(repo.id)}
              className="sr-only peer"
            />
            <div className="w-8 h-4 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-primary-600"></div>
          </label>

          {/* GitHub Link - ghosted, visible on hover */}
          <a
            href={`https://github.com/${repo.name}`}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 text-slate-300 opacity-40 group-hover:opacity-100 hover:text-gray-900 hover:bg-gray-100 rounded transition-all"
            title="View on GitHub"
          >
            <Github className="w-3.5 h-3.5" />
          </a>

          {/* Delete Button - ghosted, visible on hover */}
          <button
            onClick={handleDeleteClick}
            className="p-1 text-slate-300 opacity-40 group-hover:opacity-100 hover:text-red-600 hover:bg-red-50 rounded transition-all"
            title="Remove repository"
          >
            <TrashIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <DeleteRepoDialog
        isOpen={isDeleteDialogOpen}
        repoName={repo.name}
        onClose={handleDeleteClose}
        onConfirm={handleDeleteConfirm}
        isLoading={isDeleting}
      />
    </div>
  );
};

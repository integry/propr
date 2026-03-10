import React, { useState } from 'react';
import { Link } from 'react-router-dom';
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

const ExternalLinkIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
  </svg>
);

const GitBranchIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 3v12M6 21a3 3 0 100-6 3 3 0 000 6zM18 9a3 3 0 100-6 3 3 0 000 6zM6 15a3 3 0 00-3 3M18 6a9 9 0 01-9 9" />
  </svg>
);

// Code Chip component for consistent styling of technical entities
const CodeChip: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <code className={`px-1.5 py-0.5 bg-gray-100 text-gray-700 text-xs font-mono rounded-md border border-gray-200 ${className}`}>
    {children}
  </code>
);

interface RepositoryListItemProps {
  repo: MonitoredRepo;
  indexingStatuses: Record<string, RepositoryIndexingStatus>;
  onToggle: (repoId: string) => void;
  onRemove: (repoId: string) => void;
  onStopIndexing: (repoName: string, baseBranch?: string) => void;
  onReindex: (repoName: string, baseBranch?: string) => void;
}

export const RepositoryListItem: React.FC<RepositoryListItemProps> = ({
  repo,
  indexingStatuses,
  onToggle,
  onRemove,
  onStopIndexing,
  onReindex,
}) => {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const handleOpenDeleteDialog = () => {
    setIsDeleteDialogOpen(true);
  };

  const handleCloseDeleteDialog = () => {
    setIsDeleteDialogOpen(false);
  };

  const handleConfirmDelete = () => {
    onRemove(repo.id);
    setIsDeleteDialogOpen(false);
  };

  return (
    <div className="border-b border-slate-100 py-4 first:pt-0">
      {/* --- Repository Header: [Name/Alias] [Branch Chip] ... [Toggle] [Browse] [Delete] --- */}
      <div className="flex items-center justify-between">
        <div className={`flex items-center gap-2 ${repo.enabled ? 'opacity-100' : 'opacity-50'}`}>
          {repo.alias ? (
            <>
              <span className="font-semibold text-gray-900">{repo.alias}</span>
              <CodeChip>{repo.name}</CodeChip>
            </>
          ) : (
            <CodeChip className="text-sm">{repo.name}</CodeChip>
          )}
          {repo.baseBranch && (
            <span className="inline-flex items-center gap-1">
              <GitBranchIcon className="w-3 h-3 text-gray-400" />
              <CodeChip className="bg-blue-50 text-blue-700 border-blue-200">{repo.baseBranch}</CodeChip>
            </span>
          )}
          <IndexingStatusIndicator
            status={indexingStatuses[getRepoStatusKey(repo.name, repo.baseBranch)]}
            onStop={() => onStopIndexing(repo.name, repo.baseBranch)}
            onReindex={() => onReindex(repo.name, repo.baseBranch)}
          />
        </div>

        <div className="flex items-center gap-1.5">
          {/* Toggle Switch */}
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={repo.enabled}
              onChange={() => onToggle(repo.id)}
              className="sr-only peer"
            />
            <div className="w-8 h-4 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-primary-600"></div>
          </label>

          {/* Browse Button */}
          <Link
            to={`/summaries/${repo.name}`}
            className="p-1 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded transition-colors"
            title="Browse repository"
          >
            <ExternalLinkIcon className="w-3.5 h-3.5" />
          </Link>

          {/* Delete Button */}
          <button
            onClick={handleOpenDeleteDialog}
            className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
            title="Remove repository"
          >
            <TrashIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <DeleteRepoDialog
        isOpen={isDeleteDialogOpen}
        onClose={handleCloseDeleteDialog}
        onConfirm={handleConfirmDelete}
        repoName={repo.name}
      />
    </div>
  );
};

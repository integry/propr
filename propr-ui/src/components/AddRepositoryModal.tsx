// CI retrigger
import React from 'react';
import { BaseBranchSelector } from './BaseBranchSelector';

interface AddRepositoryModalProps {
  isOpen: boolean;
  newRepo: string;
  newAlias: string;
  newBaseBranch: string;
  autoFollowupOnFailedCi: boolean;
  availableRepos: string[];
  onRepoChange: (value: string) => void;
  onAliasChange: (value: string) => void;
  onBaseBranchChange: (value: string) => void;
  onAutoFollowupOnFailedCiChange: (value: boolean) => void;
  onAdd: () => void;
  onClose: () => void;
  isReadOnly?: boolean;
}

export const AddRepositoryModal: React.FC<AddRepositoryModalProps> = ({
  isOpen,
  newRepo,
  newAlias,
  newBaseBranch,
  autoFollowupOnFailedCi,
  availableRepos,
  onRepoChange,
  onAliasChange,
  onBaseBranchChange,
  onAutoFollowupOnFailedCiChange,
  onAdd,
  onClose,
  isReadOnly = false,
}) => {
  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;
    onAdd();
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={handleBackdropClick}
    >
      <div className="bg-white rounded-lg max-w-lg w-full flex flex-col border border-gray-300 shadow-lg">
        {/* Modal Header */}
        <div className="flex justify-between items-center px-4 py-3 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900">
            Add Repository
          </h3>
          <button
            className="text-gray-500 hover:text-gray-700 text-2xl leading-none"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        {/* Modal Content */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Repository *</label>
            <input
              list="available-repos"
              value={newRepo}
              onChange={(e) => onRepoChange(e.target.value)}
              placeholder="owner/repo"
              className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md font-mono text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              autoFocus
              disabled={isReadOnly}
            />
            <datalist id="available-repos">
              {availableRepos.map(repo => <option key={repo} value={repo} />)}
            </datalist>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Alias (optional)</label>
            <input
              value={newAlias}
              onChange={(e) => onAliasChange(e.target.value)}
              placeholder="e.g., Production"
              className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              disabled={isReadOnly}
            />
            <p className="text-xs text-gray-500 mt-1">
              A friendly name to help identify this repository.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Base Branch (optional)</label>
            <BaseBranchSelector
              repoName={newRepo}
              value={newBaseBranch}
              onChange={onBaseBranchChange}
              placeholder="Select branch..."
              disabled={isReadOnly}
            />
            <p className="text-xs text-gray-500 mt-1">
              You can add the same repository multiple times with different base branches.
            </p>
          </div>

          <label className="flex items-start gap-3 rounded-md border border-gray-200 p-3">
            <input
              type="checkbox"
              checked={autoFollowupOnFailedCi}
              onChange={(e) => onAutoFollowupOnFailedCiChange(e.target.checked)}
              disabled={isReadOnly}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            <span>
              <span className="block text-sm font-medium text-gray-700">Automatic CI follow-up</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                Start an automatic follow-up when this repository's CI fails. Off by default.
              </span>
            </span>
          </label>
        </form>

        {/* Modal Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onAdd}
            disabled={!newRepo || isReadOnly}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              !newRepo || isReadOnly
                ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                : 'bg-primary-600 text-white hover:bg-primary-700'
            }`}
          >
            Add Repository
          </button>
        </div>
      </div>
    </div>
  );
};

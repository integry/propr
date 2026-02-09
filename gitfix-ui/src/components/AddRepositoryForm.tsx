import React from 'react';
import { BaseBranchSelector } from './BaseBranchSelector';

interface AddRepositoryFormProps {
  newRepo: string;
  newAlias: string;
  newBaseBranch: string;
  availableRepos: string[];
  onRepoChange: (value: string) => void;
  onAliasChange: (value: string) => void;
  onBaseBranchChange: (value: string) => void;
  onAdd: () => void;
}

export const AddRepositoryForm: React.FC<AddRepositoryFormProps> = ({
  newRepo,
  newAlias,
  newBaseBranch,
  availableRepos,
  onRepoChange,
  onAliasChange,
  onBaseBranchChange,
  onAdd,
}) => {
  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-6">
      <h3 className="text-sm font-medium text-gray-700 mb-3">Add New Repository</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="lg:col-span-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">Repository *</label>
          <input
            list="available-repos"
            value={newRepo}
            onChange={(e) => onRepoChange(e.target.value)}
            placeholder="owner/repo"
            className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md font-mono text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
          <datalist id="available-repos">
            {availableRepos.map(repo => <option key={repo} value={repo} />)}
          </datalist>
        </div>
        <div className="lg:col-span-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">Alias (optional)</label>
          <input
            value={newAlias}
            onChange={(e) => onAliasChange(e.target.value)}
            placeholder="e.g., Production"
            className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
        </div>
        <div className="lg:col-span-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">Base Branch (optional)</label>
          <BaseBranchSelector
            repoName={newRepo}
            value={newBaseBranch}
            onChange={onBaseBranchChange}
            placeholder="Select branch..."
          />
        </div>
        <div className="lg:col-span-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">&nbsp;</label>
          <button
            onClick={onAdd}
            disabled={!newRepo}
            className={`w-full px-4 py-2 font-medium rounded-md transition-colors ${
              !newRepo
                ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                : 'bg-green-600 text-white hover:bg-green-700 cursor-pointer'
            }`}
          >
            Add Repository
          </button>
          {!newRepo && (
            <p className="text-xs text-gray-500 mt-1">Select a repository first</p>
          )}
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-2">
        You can add the same repository multiple times with different base branches to monitor multiple branches.
      </p>
    </div>
  );
};

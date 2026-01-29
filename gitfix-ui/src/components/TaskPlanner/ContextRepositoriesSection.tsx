import React, { useState } from 'react';
import { BookOpen, Plus, X, Info, GitBranch } from 'lucide-react';
import { ContextRepository } from '../../api/plannerApi';

interface ContextRepositoriesSectionProps {
  repositories: ContextRepository[];
  availableRepos: string[];
  onAdd: (repo: ContextRepository) => void;
  onRemove: (repository: string) => void;
  isLoading?: boolean;
}

export const ContextRepositoriesSection: React.FC<ContextRepositoriesSectionProps> = ({
  repositories,
  availableRepos,
  onAdd,
  onRemove,
  isLoading = false
}) => {
  const [newRepo, setNewRepo] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);

  const handleAdd = () => {
    if (!newRepo.trim()) return;
    onAdd({
      repository: newRepo.trim(),
      branch: newBranch.trim() || undefined,
      description: newDescription.trim() || undefined
    });
    setNewRepo('');
    setNewBranch('');
    setNewDescription('');
  };

  // Filter out already added repos
  const filteredRepos = availableRepos.filter(
    repo => !repositories.some(r => r.repository === repo)
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-gray-500" />
          <label className="text-sm font-medium text-gray-700">
            Additional Context Repositories
          </label>
          <span className="text-xs text-gray-400">(optional)</span>
        </div>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-sm text-indigo-600 hover:text-indigo-700"
        >
          {isExpanded ? 'Collapse' : 'Add repositories'}
        </button>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
        <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-blue-700">
          Add repositories containing examples, documentation, or reference code.
          Content from these repos will be included as <strong>reference only</strong> —
          all implementation will be done in the target repository.
        </p>
      </div>

      {/* Added repositories list */}
      {repositories.length > 0 && (
        <div className="space-y-2">
          {repositories.map((repo, index) => (
            <div
              key={`${repo.repository}-${index}`}
              className="flex items-center justify-between p-3 bg-gray-50 border border-gray-200 rounded-lg"
            >
              <div className="flex items-center gap-3">
                <BookOpen className="w-4 h-4 text-gray-400" />
                <div>
                  <span className="font-mono text-sm text-gray-900">
                    {repo.repository}
                  </span>
                  {repo.branch && (
                    <span className="ml-2 text-xs text-gray-500">
                      <GitBranch className="w-3 h-3 inline mr-1" />
                      {repo.branch}
                    </span>
                  )}
                  {repo.description && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      {repo.description}
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => onRemove(repo.repository)}
                className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"
                title="Remove"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new repository form */}
      {isExpanded && (
        <div className="p-4 border border-gray-200 rounded-lg bg-gray-50 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Repository
              </label>
              <input
                list="context-repos"
                value={newRepo}
                onChange={(e) => setNewRepo(e.target.value)}
                placeholder="owner/repo"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
              <datalist id="context-repos">
                {filteredRepos.map(repo => (
                  <option key={repo} value={repo} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Branch (optional)
              </label>
              <input
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                placeholder="main"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Description (optional)
            </label>
            <input
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="e.g., UI component examples"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
          <button
            onClick={handleAdd}
            disabled={!newRepo.trim() || isLoading}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
            Add Repository
          </button>
        </div>
      )}
    </div>
  );
};

export default ContextRepositoriesSection;

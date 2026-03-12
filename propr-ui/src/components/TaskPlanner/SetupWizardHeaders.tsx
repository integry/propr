import React from 'react';
import { ChevronDown, Github } from 'lucide-react';

interface Repo { name: string; enabled: boolean; baseBranch?: string; }

// Helper to format repository name with bold repo part
export const FormatRepoName: React.FC<{ repository: string }> = ({ repository }) => {
  const parts = repository.split('/');
  if (parts.length === 2) {
    return (
      <>
        <span className="text-gray-500">{parts[0]}/</span>
        <span className="font-semibold text-gray-700">{parts[1]}</span>
      </>
    );
  }
  return <span className="text-gray-700">{repository}</span>;
};

// Header for new mode (repository selector) - IDE-style breadcrumb layout
export const NewModeHeader: React.FC<{
  reposLoading: boolean;
  selectedRepo: string;
  repos: Repo[];
  onRepoChange?: (repo: string) => void;
  branches: string[];
  baseBranch: string;
  isLoadingBranches: boolean;
  onBranchChange: (branch: string) => void;
}> = ({ reposLoading, selectedRepo, repos, onRepoChange, branches, baseBranch, isLoadingBranches, onBranchChange }) => {
  if (reposLoading) {
    return <span className="text-gray-400 text-sm">Loading repositories...</span>;
  }

  return (
    <>
      {/* Repository selector - breadcrumb style */}
      <div className="relative inline-flex items-center max-w-full sm:max-w-[50%]">
        <Github className="w-4 h-4 text-gray-500 mr-1.5 flex-shrink-0" />
        <select
          value={selectedRepo}
          onChange={(e) => onRepoChange?.(e.target.value)}
          className="appearance-none bg-transparent border-none text-sm pr-5 py-0.5 font-mono text-gray-700 hover:text-indigo-600 focus:outline-none cursor-pointer transition-colors truncate max-w-full"
          disabled={repos.length === 0}
          title="Select repository"
        >
          {repos.length === 0 ? (
            <option value="">No repositories available</option>
          ) : (
            <>
              <option value="">Select repository</option>
              {repos.map(repo => (
                <option key={repo.name} value={repo.name}>{repo.name}</option>
              ))}
            </>
          )}
        </select>
        <ChevronDown className="w-3.5 h-3.5 text-gray-400 absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>
      {/* Show branch selector when repo is selected */}
      {selectedRepo && (
        <>
          <span className="text-gray-400 flex-shrink-0 mx-0.5">/</span>
          <div className="relative inline-flex items-center max-w-full sm:max-w-[50%]">
            {isLoadingBranches ? (
              <span className="text-gray-400 text-sm">Loading...</span>
            ) : (
              <>
                <select
                  value={baseBranch}
                  onChange={(e) => onBranchChange(e.target.value)}
                  className="appearance-none bg-transparent border-none text-sm pr-5 py-0.5 font-mono text-gray-700 hover:text-indigo-600 focus:outline-none cursor-pointer transition-colors truncate max-w-full"
                  disabled={branches.length === 0}
                  title="Select branch"
                >
                  {branches.length === 0 ? (
                    <option value="">No branches</option>
                  ) : (
                    branches.map(branch => (
                      <option key={branch} value={branch}>{branch}</option>
                    ))
                  )}
                </select>
                <ChevronDown className="w-3.5 h-3.5 text-gray-400 absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none" />
              </>
            )}
          </div>
        </>
      )}
    </>
  );
};

// Header for edit mode (branch selector) - IDE-style breadcrumb layout
export const EditModeHeader: React.FC<{
  repository: string;
  isRepoLoading: boolean;
  baseBranch: string;
  branches: string[];
  branchError: string | null;
  repoError: string | null;
  onBranchChange: (branch: string) => void;
  isChangingRepo?: boolean;
  onChangeRepoClick?: () => void;
  repos: Repo[];
  onRepoChange: (repo: string) => void;
  reposLoading: boolean;
}> = ({ repository, isRepoLoading, baseBranch, branches, branchError, repoError, onBranchChange, repos, onRepoChange, reposLoading }) => {
  // Ensure the current repository is always in the options list
  const repoOptions = repos.length > 0 ? repos : (repository ? [{ name: repository, enabled: true }] : []);
  // Add the current repository to the list if it's not already there
  const hasCurrentRepo = repoOptions.some(r => r.name === repository);
  const finalRepoOptions = hasCurrentRepo || !repository ? repoOptions : [{ name: repository, enabled: true }, ...repoOptions];

  return (
    <>
      {/* Repository - always clickable dropdown styled as breadcrumb */}
      <div className="relative inline-flex items-center max-w-full sm:max-w-[50%]">
        <Github className="w-4 h-4 text-gray-500 mr-1.5 flex-shrink-0" />
        <select
          value={repository}
          onChange={(e) => onRepoChange(e.target.value)}
          className="appearance-none bg-transparent border-none text-sm pr-5 py-0.5 font-mono text-gray-700 hover:text-indigo-600 focus:outline-none cursor-pointer transition-colors truncate max-w-full"
          disabled={reposLoading}
          title="Click to change repository"
        >
          {reposLoading ? (
            <option value="">Loading...</option>
          ) : finalRepoOptions.length === 0 ? (
            <option value="">No repositories available</option>
          ) : (
            finalRepoOptions.map(repo => (
              <option key={repo.name} value={repo.name}>{repo.name}</option>
            ))
          )}
        </select>
        <ChevronDown className="w-3.5 h-3.5 text-gray-400 absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>
      <span className="text-gray-400 flex-shrink-0 mx-0.5">/</span>
      {/* Branch selector - breadcrumb style */}
      <div className="relative inline-flex items-center max-w-full sm:max-w-[50%]">
        {isRepoLoading ? (
          <span className="text-gray-400 text-sm">Loading...</span>
        ) : (
          <>
            <select
              value={baseBranch}
              onChange={(e) => onBranchChange(e.target.value)}
              className="appearance-none bg-transparent border-none text-sm pr-5 py-0.5 font-mono text-gray-700 hover:text-indigo-600 focus:outline-none cursor-pointer transition-colors truncate max-w-full"
              disabled={branches.length === 0}
              title="Click to change branch"
            >
              {branches.length === 0 ? (
                <option value="">No branches</option>
              ) : (
                branches.map(branch => (
                  <option key={branch} value={branch}>{branch}</option>
                ))
              )}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-gray-400 absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none" />
          </>
        )}
      </div>
      {(branchError || repoError) && (
        <span className="text-red-500 text-xs ml-2 flex-shrink-0">{branchError || repoError}</span>
      )}
    </>
  );
};

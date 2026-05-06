import React, { useMemo } from 'react';
import { GitBranch } from 'lucide-react';
import { RepositorySelector, RepoOption, RepoSelection } from '../RepositorySelector';

interface Repo { name: string; enabled: boolean; baseBranch?: string; starred?: boolean; iconPath?: string | null; }

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

const BranchBadge: React.FC<{ baseBranch: string }> = ({ baseBranch }) => (
  <span
    className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700 max-w-full"
    title={baseBranch || 'Branch unavailable'}
  >
    <GitBranch className="h-3 w-3 flex-shrink-0" />
    <span className="truncate font-mono">{baseBranch || 'Unavailable'}</span>
  </span>
);

// Header for new mode (repository selector) - IDE-style breadcrumb layout
export const NewModeHeader: React.FC<{
  reposLoading: boolean;
  selectedRepo: string;
  selectedBaseBranch?: string;
  repos: Repo[];
  onRepoChange?: (repo: string, selection?: RepoSelection) => void;
  baseBranch: string;
  isLoadingBranches: boolean;
}> = ({ reposLoading, selectedRepo, selectedBaseBranch, repos, onRepoChange, baseBranch, isLoadingBranches }) => {
  if (reposLoading) {
    return <span className="text-gray-400 text-sm">Loading repositories...</span>;
  }

  return (
    <>
      <div className="relative inline-flex items-center max-w-[55%] sm:max-w-[50%]">
        <RepositorySelector
          repos={repos as RepoOption[]}
          selectedRepo={selectedRepo}
          selectedBaseBranch={selectedBaseBranch}
          onRepoChange={(repo, selection) => onRepoChange?.(repo, selection)}
          disabled={repos.length === 0}
          variant="breadcrumb"
          placeholder="Select repository"
        />
      </div>
      {selectedRepo && (
        <>
          <span className="text-gray-400 flex-shrink-0">/</span>
          <div className="inline-flex items-center max-w-[40%] sm:max-w-[50%]">
            {isLoadingBranches ? (
              <span className="text-gray-400 text-sm">Loading...</span>
            ) : (
              <BranchBadge baseBranch={baseBranch} />
            )}
          </div>
        </>
      )}
    </>
  );
};

// Header for edit mode - IDE-style breadcrumb layout
export const EditModeHeader: React.FC<{
  repository: string;
  isRepoLoading: boolean;
  baseBranch: string;
  selectedBaseBranch?: string;
  branchError: string | null;
  repoError: string | null;
  isChangingRepo?: boolean;
  onChangeRepoClick?: () => void;
  repos: Repo[];
  onRepoChange: (repo: string, selection?: RepoSelection) => void;
  reposLoading: boolean;
}> = ({ repository, isRepoLoading, baseBranch, selectedBaseBranch, branchError, repoError, repos, onRepoChange, reposLoading }) => {
  const finalRepoOptions = useMemo(() => {
    const options = repos.length > 0 ? repos : (repository ? [{ name: repository, enabled: true }] : []);
    const hasCurrentRepo = options.some(r => r.name === repository && (r.baseBranch || '') === (selectedBaseBranch || ''))
      || options.some(r => r.name === repository && !selectedBaseBranch);
    return hasCurrentRepo || !repository ? options : [{ name: repository, enabled: true, baseBranch: selectedBaseBranch || undefined }, ...options];
  }, [repos, repository, selectedBaseBranch]);

  return (
    <>
      <div className="relative inline-flex items-center max-w-[55%] sm:max-w-[50%]">
        <RepositorySelector
          repos={finalRepoOptions as RepoOption[]}
          selectedRepo={repository}
          selectedBaseBranch={selectedBaseBranch}
          onRepoChange={onRepoChange}
          disabled={reposLoading}
          isLoading={reposLoading}
          variant="breadcrumb"
          placeholder="Select repository"
        />
      </div>
      <span className="text-gray-400 flex-shrink-0">/</span>
      <div className="inline-flex items-center max-w-[40%] sm:max-w-[50%]">
        {isRepoLoading ? (
          <span className="text-gray-400 text-sm">Loading...</span>
        ) : (
          <BranchBadge baseBranch={baseBranch} />
        )}
      </div>
      {(branchError || repoError) && (
        <span className="text-red-500 text-xs ml-2 flex-shrink-0">{branchError || repoError}</span>
      )}
    </>
  );
};

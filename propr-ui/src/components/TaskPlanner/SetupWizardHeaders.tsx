import React, { useMemo } from 'react';
import { AlertTriangle, GitBranch } from 'lucide-react';
import { RepositorySelector, RepoOption, RepoSelection } from '../RepositorySelector';

interface Repo { name: string; enabled: boolean; baseBranch?: string; starred?: boolean; iconPath?: string | null; }
const BRANCH_TOOLTIP = 'Planner Studio uses the repository entry\'s configured branch. To plan against a different branch, add the repository again in Repositories with that branch.';

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

// The branch a repository entry is configured for, when only one entry matches.
const soleConfiguredBranch = (repos: Repo[], repository: string): string | undefined => {
  const matches = repos.filter(r => r.name === repository);
  return matches.length === 1 ? matches[0].baseBranch : undefined;
};

const BRANCH_CHIP_CLASSES = {
  resolved: 'border-slate-200 bg-slate-50 text-slate-700',
  verifying: 'border-slate-200 bg-slate-50 text-slate-400',
  failed: 'border-amber-200 bg-amber-50 text-amber-800',
} as const;

// Target branch as a code chip, in one of three states: resolved, still verifying (the lookup has
// not finished, or not started yet), or failed. Only a failed lookup shows the amber warning; the
// configured name stays visible so the user can see which branch could not be confirmed.
export const BranchBadge: React.FC<{ baseBranch: string; fallbackBranch?: string; failed?: boolean }> = ({ baseBranch, fallbackBranch, failed = false }) => {
  const branchName = baseBranch || fallbackBranch || '';
  const status = baseBranch ? 'resolved' : failed ? 'failed' : 'verifying';
  const label = status === 'failed' ? `${branchName || 'branch'} (unverified)` : branchName || 'branch';
  const titles = {
    resolved: `${baseBranch}\n\n${BRANCH_TOOLTIP}`,
    verifying: `Verifying ${branchName || 'the branch'}…\n\n${BRANCH_TOOLTIP}`,
    failed: `Branch status unavailable. Plans can only be generated against a verified branch.\n\n${BRANCH_TOOLTIP}`,
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-mono max-w-full ${BRANCH_CHIP_CLASSES[status]}`}
      title={titles[status]}
      data-testid="branch-chip"
      data-status={status}
    >
      <GitBranch className="h-3 w-3 flex-shrink-0" />
      <span className="truncate">{label}</span>
      {status === 'failed' && <AlertTriangle className="h-3 w-3 flex-shrink-0 text-amber-500" aria-label="Branch status unavailable" />}
    </span>
  );
};

// Header for new mode (repository selector) - IDE-style breadcrumb layout
export const NewModeHeader: React.FC<{
  reposLoading: boolean;
  selectedRepo: string;
  selectedBaseBranch?: string;
  repos: Repo[];
  onRepoChange?: (repo: string, selection?: RepoSelection) => void;
  baseBranch: string;
  isLoadingBranches: boolean;
  branchError?: string | null;
}> = ({ reposLoading, selectedRepo, selectedBaseBranch, repos, onRepoChange, baseBranch, isLoadingBranches, branchError }) => {
  if (reposLoading) {
    return <span className="text-gray-400 text-sm">Loading repositories...</span>;
  }

  return (
    <>
      <div className="relative inline-flex shrink-0 items-center whitespace-nowrap max-w-[12rem] sm:max-w-[50%]">
        <RepositorySelector
          repos={repos as RepoOption[]}
          selectedRepo={selectedRepo}
          selectedBaseBranch={selectedBaseBranch}
          onRepoChange={onRepoChange || (() => {})}
          disabled={repos.length === 0}
          variant="breadcrumb"
          placeholder="Select repository"
        />
      </div>
      {selectedRepo && (
        <>
          <div className="inline-flex min-w-0 items-center sm:max-w-[50%]">
            {isLoadingBranches ? (
              <span className="text-gray-400 text-sm">Loading...</span>
            ) : (
              <BranchBadge baseBranch={baseBranch} fallbackBranch={selectedBaseBranch || soleConfiguredBranch(repos, selectedRepo)} failed={!!branchError} />
            )}
          </div>
        </>
      )}
      {branchError && (
        <span className="text-red-500 text-xs ml-2 flex-shrink-0">{branchError}</span>
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
  configuredBaseBranch?: string;
  branchError: string | null;
  repoError: string | null;
  repos: Repo[];
  onRepoChange: (repo: string, selection?: RepoSelection) => void;
  reposLoading: boolean;
}> = ({ repository, isRepoLoading, baseBranch, selectedBaseBranch, configuredBaseBranch, branchError, repoError, repos, onRepoChange, reposLoading }) => {
  const finalRepoOptions = useMemo(() => {
    const options = repos.length > 0 ? repos : (repository ? [{ name: repository, enabled: true }] : []);
    const currentBaseBranch = configuredBaseBranch || '';
    const hasCurrentRepo = options.some(r => r.name === repository && (r.baseBranch || '') === currentBaseBranch)
      || options.some(r => r.name === repository && !currentBaseBranch);
    return hasCurrentRepo || !repository || !currentBaseBranch
      ? options
      : [{ name: repository, enabled: true, baseBranch: currentBaseBranch }, ...options];
  }, [repos, repository, configuredBaseBranch]);

  const selectorBaseBranch = useMemo(() => {
    if (configuredBaseBranch) return configuredBaseBranch;
    if (!selectedBaseBranch) return undefined;
    return finalRepoOptions.some(repo => repo.name === repository && repo.baseBranch === selectedBaseBranch)
      ? selectedBaseBranch
      : undefined;
  }, [configuredBaseBranch, finalRepoOptions, repository, selectedBaseBranch]);

  return (
    <>
      <div className="relative inline-flex shrink-0 items-center whitespace-nowrap max-w-[12rem] sm:max-w-[50%]">
        <RepositorySelector
          repos={finalRepoOptions as RepoOption[]}
          selectedRepo={repository}
          selectedBaseBranch={selectorBaseBranch}
          onRepoChange={onRepoChange}
          disabled={reposLoading}
          isLoading={reposLoading}
          variant="breadcrumb"
          placeholder="Select repository"
        />
      </div>
      <div className="inline-flex min-w-0 items-center sm:max-w-[50%]">
        {isRepoLoading ? (
          <span className="text-gray-400 text-sm">Loading...</span>
        ) : (
          <BranchBadge baseBranch={baseBranch} fallbackBranch={selectorBaseBranch || soleConfiguredBranch(finalRepoOptions, repository)} failed={!!(branchError || repoError)} />
        )}
      </div>
      {(branchError || repoError) && (
        <span className="text-red-500 text-xs ml-2 flex-shrink-0">{branchError || repoError}</span>
      )}
    </>
  );
};

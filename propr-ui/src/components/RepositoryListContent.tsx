import React, { useMemo } from 'react';
import { RepositoryIndexingStatus, MonitoredRepo } from '../api/proprApi';
import { RepositoryListItem } from './RepositoryListItem';
import { EmptyRepositoryState } from './EmptyRepositoryState';
import { RepositoriesLoadingState } from './RepositoriesLoadingState';
import { RepositoriesErrorState } from './RepositoriesErrorState';

// Organization header component - Utility Header style
const OrganizationHeader: React.FC<{ name: string; isFirst?: boolean }> = ({ name, isFirst }) => (
  <div className={`px-4 ${isFirst ? 'pt-3' : 'pt-6'} pb-2`}>
    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
      {name}
    </span>
  </div>
);

interface RepositoryListContentProps {
  repos: MonitoredRepo[];
  loading: boolean;
  error: string | null;
  indexingStatuses: Record<string, RepositoryIndexingStatus>;
  selectedRepoId: string | null;
  onToggle: (repoId: string) => void;
  onRemove: (repoId: string) => void;
  onStopIndexing: (repoName: string, baseBranch?: string) => void;
  onReindex: (repoName: string, baseBranch?: string) => void;
  onSelect: (repoId: string) => void;
  onRetry: () => void;
}

export const RepositoryListContent: React.FC<RepositoryListContentProps> = ({
  repos,
  loading,
  error,
  indexingStatuses,
  selectedRepoId,
  onToggle,
  onRemove,
  onStopIndexing,
  onReindex,
  onSelect,
  onRetry,
}) => {
  // Group repositories by organization (owner) - must be called unconditionally
  const groupedRepos = useMemo(() => {
    const groups: Record<string, MonitoredRepo[]> = {};
    repos.forEach(repo => {
      const [org] = repo.name.split('/');
      if (!groups[org]) {
        groups[org] = [];
      }
      groups[org].push(repo);
    });
    return groups;
  }, [repos]);

  const orgNames = Object.keys(groupedRepos);

  if (loading && repos.length === 0) {
    return <RepositoriesLoadingState />;
  }

  if (error && repos.length === 0 && !loading) {
    return <RepositoriesErrorState error={error} onRetry={onRetry} />;
  }

  return (
    <div className="flex flex-col">
      {orgNames.length > 1 ? (
        // Multiple organizations - show grouped with headers
        orgNames.map((org, orgIndex) => (
          <div key={org}>
            <OrganizationHeader name={org} isFirst={orgIndex === 0} />
            {groupedRepos[org].map(repo => (
              <RepositoryListItem
                key={repo.id}
                repo={repo}
                indexingStatuses={indexingStatuses}
                onToggle={onToggle}
                onRemove={onRemove}
                onStopIndexing={onStopIndexing}
                onReindex={onReindex}
                isSelected={repo.id === selectedRepoId}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))
      ) : (
        // Single organization or no repos - don't show header
        repos.map(repo => (
          <RepositoryListItem
            key={repo.id}
            repo={repo}
            indexingStatuses={indexingStatuses}
            onToggle={onToggle}
            onRemove={onRemove}
            onStopIndexing={onStopIndexing}
            onReindex={onReindex}
            isSelected={repo.id === selectedRepoId}
            onSelect={onSelect}
          />
        ))
      )}
      {repos.length === 0 && <EmptyRepositoryState />}
    </div>
  );
};

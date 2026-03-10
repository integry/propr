import React from 'react';
import { RepositoryIndexingStatus, MonitoredRepo } from '../api/proprApi';
import { RepositoryListItem } from './RepositoryListItem';
import { EmptyRepositoryState } from './EmptyRepositoryState';
import { RepositoriesLoadingState } from './RepositoriesLoadingState';
import { RepositoriesErrorState } from './RepositoriesErrorState';

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
  if (loading && repos.length === 0) {
    return <RepositoriesLoadingState />;
  }

  if (error && repos.length === 0 && !loading) {
    return <RepositoriesErrorState error={error} onRetry={onRetry} />;
  }

  return (
    <div className="flex flex-col">
      {repos.map(repo => (
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
      {repos.length === 0 && <EmptyRepositoryState />}
    </div>
  );
};

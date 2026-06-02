import React, { useMemo } from 'react';
import { Star } from 'lucide-react';
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

// Starred section header component
const StarredHeader: React.FC<{ isFirst?: boolean }> = ({ isFirst }) => (
  <div className={`px-4 ${isFirst ? 'pt-3' : 'pt-6'} pb-2 flex items-center gap-1.5`}>
    <Star className="w-3 h-3 text-amber-500 fill-amber-500" />
    <span className="text-[10px] font-bold uppercase tracking-widest text-amber-600">
      Starred
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
  onToggleStar: (repoId: string) => void;
  onToggleHidden: (repoId: string) => void;
  onSelect: (repoId: string) => void;
  onRetry: () => void;
  isReadOnly?: boolean;
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
  onToggleStar,
  onToggleHidden,
  onSelect,
  onRetry,
  isReadOnly = false,
}) => {
  // Separate starred and non-starred repos
  const { starredRepos, unstarredRepos } = useMemo(() => {
    const starred: MonitoredRepo[] = [];
    const unstarred: MonitoredRepo[] = [];
    repos.forEach(repo => {
      if (repo.starred) {
        starred.push(repo);
      } else {
        unstarred.push(repo);
      }
    });
    return { starredRepos: starred, unstarredRepos: unstarred };
  }, [repos]);

  // Group non-starred repositories by organization (owner) - must be called unconditionally
  const groupedRepos = useMemo(() => {
    const groups: Record<string, MonitoredRepo[]> = {};
    unstarredRepos.forEach(repo => {
      const [org] = repo.name.split('/');
      if (!groups[org]) {
        groups[org] = [];
      }
      groups[org].push(repo);
    });
    return groups;
  }, [unstarredRepos]);

  const orgNames = Object.keys(groupedRepos);

  if (loading && repos.length === 0) {
    return <RepositoriesLoadingState />;
  }

  if (error && repos.length === 0 && !loading) {
    return <RepositoriesErrorState error={error} onRetry={onRetry} />;
  }

  // Helper function to render a repository list item with all props
  const renderRepoItem = (repo: MonitoredRepo) => (
    <RepositoryListItem
      key={repo.id}
      repo={repo}
      indexingStatuses={indexingStatuses}
      onToggle={onToggle}
      onRemove={onRemove}
      onStopIndexing={onStopIndexing}
      onReindex={onReindex}
      onToggleStar={onToggleStar}
      onToggleHidden={onToggleHidden}
      isSelected={repo.id === selectedRepoId}
      onSelect={onSelect}
      isReadOnly={isReadOnly}
    />
  );

  const hasStarred = starredRepos.length > 0;

  return (
    <div className="flex flex-col">
      {/* Starred repositories section */}
      {hasStarred && (
        <div>
          <StarredHeader isFirst={true} />
          {starredRepos.map(renderRepoItem)}
        </div>
      )}

      {/* Non-starred repositories */}
      {orgNames.length > 1 ? (
        // Multiple organizations - show grouped with headers
        orgNames.map((org, orgIndex) => (
          <div key={org}>
            <OrganizationHeader name={org} isFirst={!hasStarred && orgIndex === 0} />
            {groupedRepos[org].map(renderRepoItem)}
          </div>
        ))
      ) : (
        // Single organization or no repos - don't show header for unstarred
        unstarredRepos.map(renderRepoItem)
      )}
      {repos.length === 0 && <EmptyRepositoryState />}
    </div>
  );
};

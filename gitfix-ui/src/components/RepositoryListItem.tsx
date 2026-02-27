import React from 'react';
import { Link } from 'react-router-dom';
import { IndexingStatusIndicator } from './IndexingStatusIndicator';
import { RepositoryIndexingStatus, MonitoredRepo } from '../api/proprApi';
import { getRepoStatusKey } from '../api/repoIndexingApi';

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
  return (
    <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border border-gray-200 rounded-md">
      <div className="flex items-center gap-3">
        <div className={`${repo.enabled ? 'opacity-100' : 'opacity-50'}`}>
          {repo.alias ? (
            <span className="text-gray-900 font-medium">
              {repo.alias}
              <span className="font-mono text-gray-500 text-sm ml-2">({repo.name})</span>
            </span>
          ) : (
            <span className="font-mono text-gray-900">{repo.name}</span>
          )}
          {repo.baseBranch && (
            <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
              Branch: {repo.baseBranch}
            </span>
          )}
        </div>
        <IndexingStatusIndicator
          status={indexingStatuses[getRepoStatusKey(repo.name, repo.baseBranch)]}
          onStop={() => onStopIndexing(repo.name, repo.baseBranch)}
          onReindex={() => onReindex(repo.name, repo.baseBranch)}
        />
        <Link
          to={`/summaries/${repo.name}`}
          className="text-xs px-2 py-0.5 text-primary-600 hover:text-primary-700 hover:underline font-medium transition-colors"
        >
          Browse
        </Link>
      </div>
      <div className="flex items-center gap-4">
        <label className="flex items-center cursor-pointer text-gray-700">
          <input
            type="checkbox"
            checked={repo.enabled}
            onChange={() => onToggle(repo.id)}
            className="mr-2 h-4 w-4 cursor-pointer rounded border-gray-300 text-primary-600 focus:ring-primary-500"
          />
          Enabled
        </label>
        <button
          onClick={() => onRemove(repo.id)}
          className="bg-red-600 hover:bg-red-700 text-xs px-3 py-1 text-white rounded-md font-medium transition-colors"
        >
          Remove
        </button>
      </div>
    </div>
  );
};

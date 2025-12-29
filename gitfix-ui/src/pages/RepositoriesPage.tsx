import React, { useState, useEffect } from 'react';
import { getRepoConfig, updateRepoConfig, getAvailableGithubRepos, getRepositoriesIndexingStatus, RepositoryIndexingStatus } from '../api/gitfixApi';

interface Repo {
  name: string;
  enabled: boolean;
}

// Indexing status indicator component
const IndexingStatusIndicator: React.FC<{ status: RepositoryIndexingStatus | undefined }> = ({ status }) => {
  if (!status) {
    // No indexing info available - show idle/default state
    return (
      <div className="flex items-center gap-1.5" title="No indexing info">
        <div className="w-2 h-2 rounded-full bg-gray-300"></div>
      </div>
    );
  }

  const formatTimestamp = (ts: string | null) => {
    if (!ts) return 'Never';
    const date = new Date(ts);
    return date.toLocaleString();
  };

  switch (status.indexing_status) {
    case 'indexing':
      return (
        <div className="flex items-center gap-1.5" title="Indexing codebase...">
          <svg className="animate-spin h-4 w-4 text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-xs text-blue-600">Indexing...</span>
        </div>
      );
    case 'completed':
      return (
        <div className="flex items-center gap-1.5" title={`Index up to date. Last indexed: ${formatTimestamp(status.last_indexed_at)}`}>
          <svg className="h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {status.last_indexed_at && (
            <span className="text-xs text-gray-500">
              {formatTimestamp(status.last_indexed_at)}
            </span>
          )}
        </div>
      );
    case 'failed':
      return (
        <div className="flex items-center gap-1.5" title="Indexing failed. Check logs.">
          <svg className="h-4 w-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-xs text-red-600">Failed</span>
        </div>
      );
    case 'idle':
    default:
      return (
        <div className="flex items-center gap-1.5" title="Not indexed">
          <div className="w-2 h-2 rounded-full bg-gray-300"></div>
          <span className="text-xs text-gray-500">Not indexed</span>
        </div>
      );
  }
};

const RepositoriesPage: React.FC = () => {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [newRepo, setNewRepo] = useState<string>('');
  const [availableRepos, setAvailableRepos] = useState<string[]>([]);
  const [indexingStatuses, setIndexingStatuses] = useState<Record<string, RepositoryIndexingStatus>>({});

  useEffect(() => {
    loadRepos();
    loadAvailableRepos();
    loadIndexingStatuses();
  }, []);

  const loadRepos = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getRepoConfig();
      setRepos(data.repos_to_monitor || []);
    } catch (err) {
      setError((err as Error).message || 'Failed to load repositories');
    } finally {
      setLoading(false);
    }
  };

  const loadAvailableRepos = async () => {
    try {
      const data = await getAvailableGithubRepos();
      setAvailableRepos(data.repos || []);
    } catch (err) {
      console.error('Failed to load available GitHub repos:', err);
    }
  };

  const loadIndexingStatuses = async () => {
    try {
      const data = await getRepositoriesIndexingStatus();
      const statusMap: Record<string, RepositoryIndexingStatus> = {};
      for (const repo of data.repositories) {
        statusMap[repo.full_name] = repo;
      }
      setIndexingStatuses(statusMap);
    } catch (err) {
      console.error('Failed to load indexing statuses:', err);
    }
  };

  const handleAddRepo = () => {
    if (!newRepo) return;

    if (repos.some(r => r.name === newRepo)) {
      alert(`Repository "${newRepo}" has already been added to the list.`);
      return;
    }

    setRepos([...repos, { name: newRepo, enabled: true }]);
    setNewRepo('');
  };

  const handleRemoveRepo = (repoName: string) => {
    setRepos(repos.filter(r => r.name !== repoName));
  };

  const handleToggleRepo = (repoName: string) => {
    setRepos(repos.map(repo => 
      repo.name === repoName 
        ? { ...repo, enabled: !repo.enabled }
        : repo
    ));
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);
      
      // Validate that at least one repository is enabled
      const enabledRepos = repos.filter(r => r.enabled);
      if (enabledRepos.length === 0 && repos.length > 0) {
        if (!window.confirm('No repositories are enabled. This will effectively disable GitFix monitoring. Continue?')) {
          return;
        }
      }
      await updateRepoConfig(repos);
      setSuccess('Repository list updated successfully! The daemon will pick up changes within 5 minutes.');
    } catch (err) {
      setError((err as Error).message || 'Failed to update repository list');
    } finally {
      setSaving(false);
    }
  };

  if (loading && repos.length === 0) {
    return (
      <div>
        <h2 className="text-gray-900 text-2xl font-semibold mb-4">Repositories</h2>
        <p className="text-gray-600">Loading repositories...</p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-gray-900 text-2xl font-semibold mb-4">Manage Monitored Repositories</h2>
      <p className="text-gray-600 mb-4">
        Add repositories to monitor, enable/disable them, or remove them from the list. Changes will be automatically picked up by the daemon within 5 minutes.
      </p>
      
      <div className="flex gap-4 mb-6">
        <input
          list="available-repos"
          value={newRepo}
          onChange={(e) => setNewRepo(e.target.value)}
          placeholder="owner/repo or select from list"
          className="flex-1 px-3 py-2 bg-gray-50 text-gray-900 border border-gray-300 rounded-md font-mono focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
        />
        <datalist id="available-repos">
          {availableRepos
            .filter(repo => !repos.some(r => r.name === repo))
            .map(repo => <option key={repo} value={repo} />)}
        </datalist>
        <button
          onClick={handleAddRepo}
          disabled={!newRepo || repos.some(r => r.name === newRepo)}
          className={`px-4 py-2 font-medium rounded-md transition-colors ${
            !newRepo || repos.some(r => r.name === newRepo)
              ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
              : 'bg-green-600 text-white hover:bg-green-700 cursor-pointer'
          }`}
        >
          Add Repository
        </button>
      </div>

      <div className="flex flex-col gap-2 mb-6">
        {repos.map(repo => (
          <div
            key={repo.name}
            className="flex items-center justify-between px-4 py-3 bg-gray-50 border border-gray-200 rounded-md"
          >
            <div className="flex items-center gap-3">
              <span className={`font-mono text-gray-900 ${repo.enabled ? 'opacity-100' : 'opacity-50'}`}>
                {repo.name}
              </span>
              <IndexingStatusIndicator status={indexingStatuses[repo.name]} />
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center cursor-pointer text-gray-700">
                <input
                  type="checkbox"
                  checked={repo.enabled}
                  onChange={() => handleToggleRepo(repo.name)}
                  className="mr-2 h-4 w-4 cursor-pointer rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                Enabled
              </label>
              <button
                onClick={() => handleRemoveRepo(repo.name)}
                className="bg-red-600 hover:bg-red-700 text-xs px-3 py-1 text-white rounded-md font-medium transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {repos.length === 0 && (
          <p className="text-gray-600 text-center py-8">
            No repositories configured. Add a repository to get started.
          </p>
        )}
      </div>
      
      <button
        onClick={handleSave}
        disabled={saving || repos.length === 0}
        className={`px-6 py-3 font-medium rounded-md transition-colors ${
          saving || repos.length === 0
            ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
            : 'bg-primary-600 text-white hover:bg-primary-700 cursor-pointer'
        }`}
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
      
      {error && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-md text-red-700">
          {error}
        </div>
      )}
      
      {success && (
        <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-md text-green-700">
          {success}
        </div>
      )}
    </div>
  );
};

export default RepositoriesPage;
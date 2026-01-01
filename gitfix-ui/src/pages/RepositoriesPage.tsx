import { Link } from 'react-router-dom';
import React, { useState, useEffect, useCallback } from 'react';
import { getRepoConfig, updateRepoConfig, getAvailableGithubRepos, getRepositoriesIndexingStatus, RepositoryIndexingStatus, MonitoredRepo } from '../api/gitfixApi';

// Helper function to generate UUID
const generateId = (): string => crypto.randomUUID();

// Type alias for MonitoredRepo which includes id, name, enabled, alias?, baseBranch?
type Repo = MonitoredRepo;

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
  const [newAlias, setNewAlias] = useState<string>('');
  const [newBaseBranch, setNewBaseBranch] = useState<string>('');
  const [availableRepos, setAvailableRepos] = useState<string[]>([]);
  const [indexingStatuses, setIndexingStatuses] = useState<Record<string, RepositoryIndexingStatus>>({});

  const loadRepos = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getRepoConfig() as { repos_to_monitor?: unknown[] };
      const rawRepos = data.repos_to_monitor || [];

      // Transform and validate the data to ensure correct format
      // Handle both object format {id, name, enabled, alias?, baseBranch?} and legacy formats
      const validRepos: Repo[] = rawRepos
        .map((repo: unknown) => {
          if (typeof repo === 'string') {
            // Legacy format: just a string like "owner/repo"
            return { id: generateId(), name: repo, enabled: true };
          } else if (repo && typeof repo === 'object') {
            const repoObj = repo as Record<string, unknown>;
            // Object format: {id?, name, enabled, alias?, baseBranch?} or possibly {full_name, ...}
            const name = (repoObj.name as string) || (repoObj.full_name as string);
            const enabled = typeof repoObj.enabled === 'boolean' ? repoObj.enabled : true;
            const id = (repoObj.id as string) || generateId();
            const alias = repoObj.alias as string | undefined;
            const baseBranch = repoObj.baseBranch as string | undefined;
            if (name) {
              return { id, name, enabled, alias, baseBranch };
            }
          }
          return null;
        })
        .filter((repo): repo is Repo => repo !== null && repo.name !== undefined);

      setRepos(validRepos);
    } catch (err) {
      setError((err as Error).message || 'Failed to load repositories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRepos();
    loadAvailableRepos();
    loadIndexingStatuses();
  }, [loadRepos]);

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

    // For duplicate detection, consider both name and baseBranch
    // Same repo can be added with different base branches
    const isDuplicate = repos.some(r =>
      r.name === newRepo &&
      (r.baseBranch || '') === (newBaseBranch || '')
    );

    if (isDuplicate) {
      const branchInfo = newBaseBranch ? ` with branch "${newBaseBranch}"` : ' with default branch';
      alert(`Repository "${newRepo}"${branchInfo} has already been added to the list.`);
      return;
    }

    const newEntry: Repo = {
      id: generateId(),
      name: newRepo,
      enabled: true,
      alias: newAlias.trim() || undefined,
      baseBranch: newBaseBranch.trim() || undefined
    };

    setRepos([...repos, newEntry]);
    setNewRepo('');
    setNewAlias('');
    setNewBaseBranch('');
  };

  const handleRemoveRepo = (repoId: string) => {
    setRepos(repos.filter(r => r.id !== repoId));
  };

  const handleToggleRepo = (repoId: string) => {
    setRepos(repos.map(repo =>
      repo.id === repoId
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
      setSuccess('Repository list updated successfully! Changes are applied immediately.');
    } catch (err) {
      setError((err as Error).message || 'Failed to update repository list');
    } finally {
      setSaving(false);
    }
  };

  if (loading && repos.length === 0) {
    return (
      <div>
        <h2 className="text-gray-900 text-2xl font-semibold mb-4">Manage Monitored Repositories</h2>
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3 text-gray-600">
            <svg className="animate-spin h-5 w-5 text-primary-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span>Loading repositories...</span>
          </div>
        </div>
      </div>
    );
  }

  // Show error state if loading failed
  if (error && repos.length === 0 && !loading) {
    return (
      <div>
        <h2 className="text-gray-900 text-2xl font-semibold mb-4">Manage Monitored Repositories</h2>
        <div className="p-6 bg-red-50 border border-red-200 rounded-md">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 text-red-500 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <h3 className="text-red-800 font-medium">Failed to load repositories</h3>
              <p className="text-red-700 mt-1">{error}</p>
              <button
                onClick={() => {
                  setError(null);
                  loadRepos();
                }}
                className="mt-3 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-md text-sm font-medium transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-gray-900 text-2xl font-semibold mb-4">Manage Monitored Repositories</h2>
      <p className="text-gray-600 mb-4">
        Add repositories to monitor, enable/disable them, or remove them from the list. Changes are applied immediately.
      </p>
      
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-6">
        <h3 className="text-sm font-medium text-gray-700 mb-3">Add New Repository</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="lg:col-span-1">
            <label className="block text-xs font-medium text-gray-600 mb-1">Repository *</label>
            <input
              list="available-repos"
              value={newRepo}
              onChange={(e) => setNewRepo(e.target.value)}
              placeholder="owner/repo"
              className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md font-mono text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
            <datalist id="available-repos">
              {availableRepos
                .map(repo => <option key={repo} value={repo} />)}
            </datalist>
          </div>
          <div className="lg:col-span-1">
            <label className="block text-xs font-medium text-gray-600 mb-1">Alias (optional)</label>
            <input
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              placeholder="e.g., Production"
              className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          <div className="lg:col-span-1">
            <label className="block text-xs font-medium text-gray-600 mb-1">Base Branch (optional)</label>
            <input
              value={newBaseBranch}
              onChange={(e) => setNewBaseBranch(e.target.value)}
              placeholder="e.g., develop"
              className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md font-mono text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
          <div className="lg:col-span-1 flex items-end">
            <button
              onClick={handleAddRepo}
              disabled={!newRepo}
              className={`w-full px-4 py-2 font-medium rounded-md transition-colors ${
                !newRepo
                  ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                  : 'bg-green-600 text-white hover:bg-green-700 cursor-pointer'
              }`}
            >
              Add Repository
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          You can add the same repository multiple times with different base branches to monitor multiple branches.
        </p>
      </div>

      <div className="flex flex-col gap-2 mb-6">
        {repos.map(repo => (
          <div
            key={repo.id}
            className="flex items-center justify-between px-4 py-3 bg-gray-50 border border-gray-200 rounded-md"
          >
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
              <IndexingStatusIndicator status={indexingStatuses[repo.name]} />
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
                  onChange={() => handleToggleRepo(repo.id)}
                  className="mr-2 h-4 w-4 cursor-pointer rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                Enabled
              </label>
              <button
                onClick={() => handleRemoveRepo(repo.id)}
                className="bg-red-600 hover:bg-red-700 text-xs px-3 py-1 text-white rounded-md font-medium transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {repos.length === 0 && (
          <div className="text-center py-12 px-4 bg-gray-50 border border-gray-200 rounded-md">
            <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <h3 className="mt-4 text-sm font-medium text-gray-900">No repositories configured</h3>
            <p className="mt-2 text-sm text-gray-500">
              Get started by adding a repository to monitor using the input field above.
            </p>
          </div>
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
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { getRepoConfig, updateRepoConfig, getAvailableGithubRepos, getRepositoriesIndexingStatus, stopRepositoryIndexing, RepositoryIndexingStatus, MonitoredRepo } from '../api/proprApi';
import { triggerRepositoryIndexing, getRepoStatusKey } from '../api/repoIndexingApi';
import { AddRepositoryForm } from '../components/AddRepositoryForm';
import { RepositoryListItem } from '../components/RepositoryListItem';

// Helper function to generate UUID
const generateId = (): string => crypto.randomUUID();

// Type alias for MonitoredRepo which includes id, name, enabled, alias?, baseBranch?
type Repo = MonitoredRepo;

const RepositoriesPage: React.FC = () => {
  useDocumentTitle('Repositories');
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [newRepo, setNewRepo] = useState<string>('');
  const [newAlias, setNewAlias] = useState<string>('');
  const [newBaseBranch, setNewBaseBranch] = useState<string>('');
  const [availableRepos, setAvailableRepos] = useState<string[]>([]);
  const [indexingStatuses, setIndexingStatuses] = useState<Record<string, RepositoryIndexingStatus>>({});
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Track repositories with pending optimistic updates to prevent server responses from overwriting them
  const pendingOptimisticUpdatesRef = useRef<Set<string>>(new Set());

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

    // Poll for indexing status updates every 3 seconds
    const pollInterval = setInterval(loadIndexingStatuses, 3000);
    return () => clearInterval(pollInterval);
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
        // Use composite key to distinguish same repo with different branches
        const key = getRepoStatusKey(repo.full_name, repo.branch);
        statusMap[key] = repo;

        // If server confirms indexing status, clear the pending optimistic update
        if (repo.indexing_status === 'indexing') {
          pendingOptimisticUpdatesRef.current.delete(key);
        }
      }

      setIndexingStatuses(prev => {
        const result = { ...statusMap };

        // Preserve optimistic updates for repos that haven't started indexing on server yet
        for (const key of pendingOptimisticUpdatesRef.current) {
          const serverStatus = statusMap[key];
          const optimisticStatus = prev[key];

          // Keep the optimistic 'indexing' state if server hasn't confirmed indexing yet
          if (optimisticStatus?.indexing_status === 'indexing' &&
              (!serverStatus || serverStatus.indexing_status !== 'indexing')) {
            result[key] = optimisticStatus;
          }
        }

        return result;
      });
    } catch (err) {
      console.error('Failed to load indexing statuses:', err);
    }
  };

  // Auto-save function
  const performAutoSave = useCallback(async (reposToSave: Repo[]) => {
    // Clear any pending save timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    setSaveStatus('saving');
    setError(null);

    try {
      // Validate that at least one repository is enabled
      const enabledRepos = reposToSave.filter(r => r.enabled);
      if (enabledRepos.length === 0 && reposToSave.length > 0) {
        if (!window.confirm('No repositories are enabled. This will effectively disable GitFix monitoring. Continue?')) {
          setSaveStatus('idle');
          return false;
        }
      }

      await updateRepoConfig(reposToSave);
      setSaveStatus('saved');

      // Clear "Saved" status after 3 seconds
      saveTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
      return true;
    } catch (err) {
      setSaveStatus('error');
      setError((err as Error).message || 'Failed to save repository configuration');
      return false;
    }
  }, []);

  const handleStopIndexing = async (repoName: string, baseBranch?: string) => {
    try {
      const displayName = baseBranch ? `${repoName} (${baseBranch})` : repoName;
      if (!confirm(`Are you sure you want to stop indexing for ${displayName}?`)) return;
      await stopRepositoryIndexing(repoName, baseBranch);
      // Short delay to allow backend to process
      setTimeout(loadIndexingStatuses, 500);
    } catch (err) {
      alert('Failed to stop indexing: ' + (err as Error).message);
    }
  };

  const handleReindexRepo = async (repoName: string, baseBranch?: string) => {
    // Calculate the status key for this repository
    const statusKey = getRepoStatusKey(repoName, baseBranch);

    // Mark this repository as having a pending optimistic update
    pendingOptimisticUpdatesRef.current.add(statusKey);

    // Optimistic UI update: immediately set status to 'indexing'
    setIndexingStatuses(prev => ({
      ...prev,
      [statusKey]: {
        // Preserve existing data if available
        ...prev[statusKey],
        full_name: repoName,
        branch: baseBranch || 'HEAD',
        indexing_status: 'indexing',
        // Ensure progress object exists for UI rendering
        progress: prev[statusKey]?.progress || {
          totalFiles: 0,
          processedFiles: 0,
          percentComplete: 0,
          inputTokens: 0,
          outputTokens: 0,
          phase: 'files' as const,
          totalDirectories: 0,
          processedDirectories: 0
        }
      }
    }));

    try {
      await triggerRepositoryIndexing(repoName, baseBranch);
      // Short delay to allow backend to process
      setTimeout(loadIndexingStatuses, 500);
    } catch (err) {
      // Clear pending optimistic update and revert by fetching actual status
      pendingOptimisticUpdatesRef.current.delete(statusKey);
      loadIndexingStatuses();
      alert('Failed to trigger reindex: ' + (err as Error).message);
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

    const newRepos = [...repos, newEntry];
    setRepos(newRepos);
    setNewRepo('');
    setNewAlias('');
    setNewBaseBranch('');
    performAutoSave(newRepos);
  };

  const handleRemoveRepo = (repoId: string) => {
    const newRepos = repos.filter(r => r.id !== repoId);
    setRepos(newRepos);
    performAutoSave(newRepos);
  };

  const handleToggleRepo = (repoId: string) => {
    const newRepos = repos.map(repo =>
      repo.id === repoId
        ? { ...repo, enabled: !repo.enabled }
        : repo
    );
    setRepos(newRepos);
    performAutoSave(newRepos);
  };

  if (loading && repos.length === 0) {
    return (
      <div className="p-4 sm:p-8">
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
      <div className="p-4 sm:p-8">
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
    <div className="p-4 sm:p-8">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-gray-900 text-2xl font-semibold">Manage Monitored Repositories</h2>
        {/* Auto-save status indicator */}
        <div className="flex items-center gap-2">
          {saveStatus === 'saving' && (
            <span className="flex items-center gap-1.5 text-sm text-gray-500">
              <svg className="animate-spin h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Saving...
            </span>
          )}
          {saveStatus === 'saved' && (
            <span className="flex items-center gap-1.5 text-sm text-green-600">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Saved
            </span>
          )}
          {saveStatus === 'error' && error && (
            <span className="flex items-center gap-1.5 text-sm text-red-600">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {error}
            </span>
          )}
        </div>
      </div>
      <p className="text-gray-600 mb-4">
        Add repositories to monitor, enable/disable them, or remove them from the list. Changes are saved automatically.
      </p>
      
      <AddRepositoryForm
        newRepo={newRepo}
        newAlias={newAlias}
        newBaseBranch={newBaseBranch}
        availableRepos={availableRepos}
        onRepoChange={setNewRepo}
        onAliasChange={setNewAlias}
        onBaseBranchChange={setNewBaseBranch}
        onAdd={handleAddRepo}
      />

      <div className="flex flex-col gap-2 mb-6">
        {repos.map(repo => (
          <RepositoryListItem
            key={repo.id}
            repo={repo}
            indexingStatuses={indexingStatuses}
            onToggle={handleToggleRepo}
            onRemove={handleRemoveRepo}
            onStopIndexing={handleStopIndexing}
            onReindex={handleReindexRepo}
          />
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
    </div>
  );
};

export default RepositoriesPage;
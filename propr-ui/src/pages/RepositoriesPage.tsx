import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { getRepoConfig, updateRepoConfig, getAvailableGithubRepos, getRepositoriesIndexingStatus, stopRepositoryIndexing, RepositoryIndexingStatus, MonitoredRepo } from '../api/proprApi';
import { triggerRepositoryIndexing, getRepoStatusKey } from '../api/repoIndexingApi';
import { AddRepositoryModal } from '../components/AddRepositoryModal';
import { RepositoryListItem } from '../components/RepositoryListItem';
import { EmptyRepositoryState } from '../components/EmptyRepositoryState';
import { RepositoriesLoadingState } from '../components/RepositoriesLoadingState';
import { RepositoriesErrorState } from '../components/RepositoriesErrorState';
import { SaveStatusIndicator } from '../components/SaveStatusIndicator';
import { useSocket } from '../contexts/useSocket';
import { IndexingUpdatePayload } from '@propr/shared';
import { buildUpdatedStatus } from '../utils/indexingStatusHelpers';

// Helper function to generate UUID
const generateId = (): string => crypto.randomUUID();

// Type alias for MonitoredRepo which includes id, name, enabled, alias?, baseBranch?
type Repo = MonitoredRepo;

const RepositoriesPage: React.FC = () => {
  useDocumentTitle('Repositories');
  const { isConnected, subscribeToIndexingUpdates, unsubscribeFromIndexingUpdates, onIndexingUpdate } = useSocket();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [newRepo, setNewRepo] = useState<string>('');
  const [newAlias, setNewAlias] = useState<string>('');
  const [newBaseBranch, setNewBaseBranch] = useState<string>('');
  const [availableRepos, setAvailableRepos] = useState<string[]>([]);
  const [indexingStatuses, setIndexingStatuses] = useState<Record<string, RepositoryIndexingStatus>>({});
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
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

  // Handle indexing updates via WebSocket
  const handleIndexingUpdate = useCallback((payload: IndexingUpdatePayload) => {
    const key = getRepoStatusKey(payload.repository, undefined);

    // If server confirms indexing status, clear the pending optimistic update
    if (payload.phase === 'indexing' || payload.phase === 'files' || payload.phase === 'directories') {
      pendingOptimisticUpdatesRef.current.delete(key);
    }

    setIndexingStatuses(prev => ({
      ...prev,
      [key]: buildUpdatedStatus(payload, prev[key])
    }));
  }, []);

  // Load initial data on mount
  useEffect(() => {
    loadRepos();
    loadAvailableRepos();
    loadIndexingStatuses();
  }, [loadRepos]);

  // Subscribe to WebSocket indexing updates when connected
  useEffect(() => {
    if (!isConnected) return;

    subscribeToIndexingUpdates();

    return () => {
      unsubscribeFromIndexingUpdates();
    };
  }, [isConnected, subscribeToIndexingUpdates, unsubscribeFromIndexingUpdates]);

  // Register WebSocket event listener
  useEffect(() => {
    const unsubscribe = onIndexingUpdate(handleIndexingUpdate);
    return () => {
      unsubscribe();
    };
  }, [onIndexingUpdate, handleIndexingUpdate]);

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
        if (!window.confirm('No repositories are enabled. This will effectively disable ProPR monitoring. Continue?')) {
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
    setIsModalOpen(false);
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

  const handleOpenModal = () => {
    setNewRepo('');
    setNewAlias('');
    setNewBaseBranch('');
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setNewRepo('');
    setNewAlias('');
    setNewBaseBranch('');
  };

  if (loading && repos.length === 0) {
    return <RepositoriesLoadingState />;
  }

  // Show error state if loading failed
  if (error && repos.length === 0 && !loading) {
    return (
      <RepositoriesErrorState
        error={error}
        onRetry={() => {
          setError(null);
          loadRepos();
        }}
      />
    );
  }

  return (
    <div className="p-4 sm:p-8">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-gray-900 text-2xl font-semibold">Manage Monitored Repositories</h2>
        <SaveStatusIndicator status={saveStatus} error={error} />
      </div>

      {/* Add Repository Modal */}
      <AddRepositoryModal
        isOpen={isModalOpen}
        newRepo={newRepo}
        newAlias={newAlias}
        newBaseBranch={newBaseBranch}
        availableRepos={availableRepos}
        onRepoChange={setNewRepo}
        onAliasChange={setNewAlias}
        onBaseBranchChange={setNewBaseBranch}
        onAdd={handleAddRepo}
        onClose={handleCloseModal}
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
        {repos.length === 0 && <EmptyRepositoryState />}
      </div>
    </div>
  );
};

export default RepositoriesPage;

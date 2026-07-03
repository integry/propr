import { useState, useCallback, useRef, useEffect } from 'react';
import {
  getRepoConfig,
  updateRepoConfig,
  getAvailableGithubRepos,
  getRepositoriesIndexingStatus,
  stopRepositoryIndexing,
  RepositoryIndexingStatus,
  MonitoredRepo,
  getUserRepoPreferences,
  updateUserRepoPreferences,
  UserRepoPreferences
} from '../api/proprApi';
import { triggerRepositoryIndexing, getRepoStatusKey } from '../api/repoIndexingApi';
import { useSocket } from '../contexts/useSocket';
import { IndexingUpdatePayload } from '@propr/shared';
import { buildUpdatedStatus } from '../utils/indexingStatusHelpers';

const generateId = (): string => crypto.randomUUID();
const TERMINAL_INDEXING_STATUSES = new Set<RepositoryIndexingStatus['indexing_status']>(['idle', 'completed', 'failed']);

function shouldIgnoreStaleProgressUpdate(
  payload: IndexingUpdatePayload,
  currentStatus: RepositoryIndexingStatus | undefined,
  hasPendingOptimisticUpdate: boolean,
  hasSeenTerminalSocketUpdate: boolean
): boolean {
  if (payload.phase !== 'files' && payload.phase !== 'directories') {
    return false;
  }
  if (hasPendingOptimisticUpdate) {
    return false;
  }

  return currentStatus ? hasSeenTerminalSocketUpdate && TERMINAL_INDEXING_STATUSES.has(currentStatus.indexing_status) : false;
}

export type Repo = MonitoredRepo;

export interface UseRepositoryManagementResult {
  repos: Repo[];
  loading: boolean;
  error: string | null;
  availableRepos: string[];
  indexingStatuses: Record<string, RepositoryIndexingStatus>;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  showHiddenRepos: boolean;
  filteredRepos: Repo[];
  hiddenCount: number;
  loadRepos: () => Promise<void>;
  handleStopIndexing: (repoName: string, baseBranch?: string) => Promise<void>;
  handleReindexRepo: (repoName: string, baseBranch?: string) => Promise<void>;
  handleAddRepo: (newRepo: string, newAlias: string, newBaseBranch: string) => boolean;
  handleRemoveRepo: (repoId: string) => void;
  handleToggleRepo: (repoId: string) => void;
  handleToggleStar: (repoId: string) => Promise<void>;
  handleToggleHidden: (repoId: string) => Promise<void>;
  handleToggleShowHidden: () => void;
  handleRetry: () => void;
  setError: (error: string | null) => void;
}

export function useRepositoryManagement(): UseRepositoryManagementResult {
  const { isConnected, subscribeToIndexingUpdates, unsubscribeFromIndexingUpdates, onIndexingUpdate } = useSocket();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [availableRepos, setAvailableRepos] = useState<string[]>([]);
  const [indexingStatuses, setIndexingStatuses] = useState<Record<string, RepositoryIndexingStatus>>({});
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [showHiddenRepos, setShowHiddenRepos] = useState<boolean>(false);
  const [_userRepoPrefs, setUserRepoPrefs] = useState<UserRepoPreferences>({});
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingOptimisticUpdatesRef = useRef<Set<string>>(new Set());
  const terminalSocketUpdatesRef = useRef<Set<string>>(new Set());

  const loadRepos = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [repoData, prefs] = await Promise.all([
        getRepoConfig() as Promise<{ repos_to_monitor?: unknown[] }>,
        getUserRepoPreferences().catch(() => ({} as UserRepoPreferences))
      ]);
      const rawRepos = repoData.repos_to_monitor || [];
      setUserRepoPrefs(prefs);
      const seenKeys = new Set<string>();
      const validRepos: Repo[] = rawRepos
        .map((repo: unknown): Repo | null => {
          if (typeof repo === 'string') {
            const userPref = prefs[repo] || {};
            return { id: generateId(), name: repo, enabled: true, starred: userPref.starred, hidden: userPref.hidden };
          } else if (repo && typeof repo === 'object') {
            const repoObj = repo as Record<string, unknown>;
            const name = (repoObj.name as string) || (repoObj.full_name as string);
            const enabled = typeof repoObj.enabled === 'boolean' ? repoObj.enabled : true;
            const id = (repoObj.id as string) || generateId();
            const alias = repoObj.alias as string | undefined;
            const baseBranch = repoObj.baseBranch as string | undefined;
            const userPref = name ? (prefs[name] || {}) : {};
            if (name) {
              return { id, name, enabled, alias, baseBranch, starred: userPref.starred, hidden: userPref.hidden };
            }
          }
          return null;
        })
        .filter((repo): repo is Repo => {
          if (repo === null) return false;
          // Use composite key: name + baseBranch to preserve legitimate
          // entries that share a name but differ by branch.
          const key = repo.baseBranch ? `${repo.name}:${repo.baseBranch}` : repo.name;
          if (seenKeys.has(key)) return false;
          seenKeys.add(key);
          return true;
        });
      setRepos(validRepos);
    } catch (err) {
      setError((err as Error).message || 'Failed to load repositories');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleIndexingUpdate = useCallback((payload: IndexingUpdatePayload) => {
    const key = getRepoStatusKey(payload.repository, payload.branch);
    setIndexingStatuses(prev => {
      const hasPendingOptimisticUpdate = pendingOptimisticUpdatesRef.current.has(key);
      const hasSeenTerminalSocketUpdate = terminalSocketUpdatesRef.current.has(key);
      if (shouldIgnoreStaleProgressUpdate(payload, prev[key], hasPendingOptimisticUpdate, hasSeenTerminalSocketUpdate)) {
        return prev;
      }

      if (payload.phase === 'completed' || payload.phase === 'failed' || payload.phase === 'idle') {
        terminalSocketUpdatesRef.current.add(key);
      } else {
        terminalSocketUpdatesRef.current.delete(key);
      }

      if (payload.phase === 'indexing' || payload.phase === 'files' || payload.phase === 'directories' || payload.phase === 'completed' || payload.phase === 'failed' || payload.phase === 'idle') {
        pendingOptimisticUpdatesRef.current.delete(key);
      }

      return { ...prev, [key]: buildUpdatedStatus(payload, prev[key]) };
    });
  }, []);

  const loadAvailableRepos = useCallback(async () => {
    try {
      const data = await getAvailableGithubRepos();
      setAvailableRepos((data as { repos?: string[] }).repos || []);
    } catch (err) {
      console.error('Failed to load available GitHub repos:', err);
    }
  }, []);

  const loadIndexingStatuses = useCallback(async () => {
    try {
      const data = await getRepositoriesIndexingStatus();
      const statusMap: Record<string, RepositoryIndexingStatus> = {};
      for (const repo of data.repositories) {
        const key = getRepoStatusKey(repo.full_name, repo.branch);
        statusMap[key] = repo;
        if (repo.indexing_status === 'indexing') {
          pendingOptimisticUpdatesRef.current.delete(key);
        }
      }
      setIndexingStatuses(prev => {
        const result = { ...statusMap };
        for (const key of pendingOptimisticUpdatesRef.current) {
          const serverStatus = statusMap[key];
          const optimisticStatus = prev[key];
          if (optimisticStatus?.indexing_status === 'indexing' && (!serverStatus || serverStatus.indexing_status !== 'indexing')) {
            result[key] = optimisticStatus;
          }
        }
        return result;
      });
    } catch (err) {
      console.error('Failed to load indexing statuses:', err);
    }
  }, []);

  useEffect(() => { loadRepos(); loadAvailableRepos(); loadIndexingStatuses(); }, [loadRepos, loadAvailableRepos, loadIndexingStatuses]);

  useEffect(() => {
    if (!isConnected) return;
    subscribeToIndexingUpdates();
    return () => { unsubscribeFromIndexingUpdates(); };
  }, [isConnected, subscribeToIndexingUpdates, unsubscribeFromIndexingUpdates]);

  useEffect(() => {
    const unsubscribe = onIndexingUpdate(handleIndexingUpdate);
    return () => { unsubscribe(); };
  }, [onIndexingUpdate, handleIndexingUpdate]);

  const performAutoSave = useCallback(async (reposToSave: Repo[]) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    setSaveStatus('saving');
    setError(null);
    try {
      const enabledRepos = reposToSave.filter(r => r.enabled);
      if (enabledRepos.length === 0 && reposToSave.length > 0) {
        if (!window.confirm('No repositories are enabled. This will effectively disable ProPR monitoring. Continue?')) {
          setSaveStatus('idle');
          return false;
        }
      }
      await updateRepoConfig(reposToSave);
      setSaveStatus('saved');
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
      if (!confirm(`Are you sure you want to stop indexing for ${displayName}? Semantic search and smart file selection for this repository will be unavailable until you re-index.`)) return;
      await stopRepositoryIndexing(repoName, baseBranch);
    } catch (err) {
      alert('Failed to stop indexing: ' + (err as Error).message);
    }
  };

  const handleReindexRepo = async (repoName: string, baseBranch?: string) => {
    const statusKey = getRepoStatusKey(repoName, baseBranch);
    pendingOptimisticUpdatesRef.current.add(statusKey);
    setIndexingStatuses(prev => ({
      ...prev,
      [statusKey]: {
        ...prev[statusKey],
        full_name: repoName,
        branch: baseBranch || 'HEAD',
        indexing_status: 'indexing',
        progress: prev[statusKey]?.progress || { totalFiles: 0, processedFiles: 0, percentComplete: 0, inputTokens: 0, outputTokens: 0, phase: 'files' as const, totalDirectories: 0, processedDirectories: 0 }
      }
    }));
    try {
      await triggerRepositoryIndexing(repoName, baseBranch);
    } catch (err) {
      pendingOptimisticUpdatesRef.current.delete(statusKey);
      loadIndexingStatuses();
      alert('Failed to trigger reindex: ' + (err as Error).message);
    }
  };

  const handleAddRepo = (newRepo: string, newAlias: string, newBaseBranch: string): boolean => {
    if (!newRepo) return false;
    const isDuplicate = repos.some(r => r.name === newRepo && (r.baseBranch || '') === (newBaseBranch || ''));
    if (isDuplicate) {
      const branchInfo = newBaseBranch ? ` with branch "${newBaseBranch}"` : ' with default branch';
      alert(`Repository "${newRepo}"${branchInfo} has already been added to the list.`);
      return false;
    }
    const newEntry: Repo = { id: generateId(), name: newRepo, enabled: true, alias: newAlias.trim() || undefined, baseBranch: newBaseBranch.trim() || undefined };
    const newRepos = [...repos, newEntry];
    setRepos(newRepos);
    performAutoSave(newRepos);
    return true;
  };

  const handleRemoveRepo = (repoId: string) => {
    const newRepos = repos.filter(r => r.id !== repoId);
    setRepos(newRepos);
    performAutoSave(newRepos);
  };

  const handleToggleRepo = (repoId: string) => {
    const newRepos = repos.map(repo => repo.id === repoId ? { ...repo, enabled: !repo.enabled } : repo);
    setRepos(newRepos);
    performAutoSave(newRepos);
  };

  const handleToggleStar = async (repoId: string) => {
    const repo = repos.find(r => r.id === repoId);
    if (!repo) return;
    const newStarred = !repo.starred;
    setRepos(prevRepos => prevRepos.map(r => r.id === repoId ? { ...r, starred: newStarred } : r));
    setUserRepoPrefs(prev => ({ ...prev, [repo.name]: { ...prev[repo.name], starred: newStarred } }));
    try {
      await updateUserRepoPreferences({ [repo.name]: { starred: newStarred } });
    } catch (err) {
      setRepos(prevRepos => prevRepos.map(r => r.id === repoId ? { ...r, starred: !newStarred } : r));
      setUserRepoPrefs(prev => ({ ...prev, [repo.name]: { ...prev[repo.name], starred: !newStarred } }));
      console.error('Failed to save starred preference:', err);
    }
  };

  const handleToggleHidden = async (repoId: string) => {
    const repo = repos.find(r => r.id === repoId);
    if (!repo) return;
    const newHidden = !repo.hidden;
    setRepos(prevRepos => prevRepos.map(r => r.id === repoId ? { ...r, hidden: newHidden } : r));
    setUserRepoPrefs(prev => ({ ...prev, [repo.name]: { ...prev[repo.name], hidden: newHidden } }));
    try {
      await updateUserRepoPreferences({ [repo.name]: { hidden: newHidden } });
    } catch (err) {
      setRepos(prevRepos => prevRepos.map(r => r.id === repoId ? { ...r, hidden: !newHidden } : r));
      setUserRepoPrefs(prev => ({ ...prev, [repo.name]: { ...prev[repo.name], hidden: !newHidden } }));
      console.error('Failed to save hidden preference:', err);
    }
  };

  const handleToggleShowHidden = () => setShowHiddenRepos(prev => !prev);
  const handleRetry = () => { setError(null); loadRepos(); };

  const hiddenCount = repos.filter(r => r.hidden).length;
  const filteredRepos = showHiddenRepos ? repos : repos.filter(r => !r.hidden);

  return {
    repos, loading, error, availableRepos, indexingStatuses, saveStatus, showHiddenRepos,
    filteredRepos, hiddenCount, loadRepos, handleStopIndexing, handleReindexRepo, handleAddRepo,
    handleRemoveRepo, handleToggleRepo, handleToggleStar, handleToggleHidden, handleToggleShowHidden,
    handleRetry, setError
  };
}

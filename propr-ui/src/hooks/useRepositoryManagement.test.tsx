import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useRepositoryManagement } from './useRepositoryManagement';
import {
  getRepoConfig,
  getAvailableGithubRepos,
  getRepositoriesIndexingStatus,
  getUserRepoPreferences,
  stopRepositoryIndexing
} from '../api/proprApi';
import { triggerRepositoryIndexing } from '../api/repoIndexingApi';

const socketState = vi.hoisted(() => ({
  isConnected: false,
  subscribeToIndexingUpdates: vi.fn(),
  unsubscribeFromIndexingUpdates: vi.fn(),
  onIndexingUpdate: vi.fn(),
  indexingHandler: undefined as ((payload: {
    repository: string;
    branch?: string;
    phase: 'indexing' | 'files' | 'directories' | 'completed' | 'failed' | 'idle';
    progress?: number;
    totalFiles?: number;
    processedFiles?: number;
    totalDirectories?: number;
    processedDirectories?: number;
    timestamp: string;
    eventType: 'indexing_update';
  }) => void) | undefined
}));

vi.mock('../api/proprApi', () => ({
  getRepoConfig: vi.fn(),
  updateRepoConfig: vi.fn(),
  getAvailableGithubRepos: vi.fn(),
  getRepositoriesIndexingStatus: vi.fn(),
  getUserRepoPreferences: vi.fn(),
  stopRepositoryIndexing: vi.fn(),
  updateUserRepoPreferences: vi.fn()
}));

vi.mock('../api/repoIndexingApi', () => ({
  triggerRepositoryIndexing: vi.fn(),
  getRepoStatusKey: (fullName: string, branch?: string) => branch && branch !== 'HEAD' ? `${fullName}:${branch}` : fullName
}));

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: socketState.isConnected,
    subscribeToIndexingUpdates: socketState.subscribeToIndexingUpdates,
    unsubscribeFromIndexingUpdates: socketState.unsubscribeFromIndexingUpdates,
    onIndexingUpdate: (callback: typeof socketState.indexingHandler) => {
      socketState.onIndexingUpdate(callback);
      socketState.indexingHandler = callback;
      return vi.fn();
    }
  })
}));

const mockGetRepoConfig = vi.mocked(getRepoConfig);
const mockGetAvailableGithubRepos = vi.mocked(getAvailableGithubRepos);
const mockGetRepositoriesIndexingStatus = vi.mocked(getRepositoriesIndexingStatus);
const mockGetUserRepoPreferences = vi.mocked(getUserRepoPreferences);
const mockStopRepositoryIndexing = vi.mocked(stopRepositoryIndexing);
const mockTriggerRepositoryIndexing = vi.mocked(triggerRepositoryIndexing);

describe('useRepositoryManagement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('alert', vi.fn());
    socketState.isConnected = false;
    socketState.indexingHandler = undefined;
    socketState.subscribeToIndexingUpdates.mockReset();
    socketState.unsubscribeFromIndexingUpdates.mockReset();
    socketState.onIndexingUpdate.mockReset();

    mockGetRepoConfig.mockResolvedValue({
      repos_to_monitor: [{ id: 'repo-1', name: 'integry/propr', enabled: true, baseBranch: 'release/2026' }]
    });
    mockGetAvailableGithubRepos.mockResolvedValue({ repos: ['integry/propr'] });
    mockGetRepositoriesIndexingStatus.mockResolvedValue({
      repositories: [{
        full_name: 'integry/propr',
        branch: 'release/2026',
        indexing_status: 'idle',
        last_indexed_at: null,
        last_indexed_hash: null,
        last_indexed_commit_message: null
      }]
    });
    mockGetUserRepoPreferences.mockResolvedValue({});
    mockStopRepositoryIndexing.mockResolvedValue({ success: true });
    mockTriggerRepositoryIndexing.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('refreshes indexing status after a successful reindex trigger', async () => {
    const { result } = renderHook(() => useRepositoryManagement());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetRepositoriesIndexingStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.handleReindexRepo('integry/propr', 'release/2026');
    });

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    await waitFor(() => expect(mockGetRepositoriesIndexingStatus).toHaveBeenCalledTimes(2));
  });

  it('refreshes indexing status after a successful stop request', async () => {
    const { result } = renderHook(() => useRepositoryManagement());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetRepositoriesIndexingStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.handleStopIndexing('integry/propr', 'release/2026');
    });

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    await waitFor(() => expect(mockGetRepositoriesIndexingStatus).toHaveBeenCalledTimes(2));
  });

  it('applies branch-aware websocket updates and clears stale progress for terminal states', async () => {
    socketState.isConnected = true;

    const { result } = renderHook(() => useRepositoryManagement());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(socketState.subscribeToIndexingUpdates).toHaveBeenCalledTimes(1);
    expect(socketState.onIndexingUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      socketState.indexingHandler?.({
        eventType: 'indexing_update',
        repository: 'integry/propr',
        branch: 'release/2026',
        phase: 'directories',
        progress: 75,
        totalFiles: 100,
        processedFiles: 100,
        totalDirectories: 20,
        processedDirectories: 15,
        timestamp: new Date().toISOString()
      });
    });

    expect(result.current.indexingStatuses['integry/propr:release/2026']).toMatchObject({
      full_name: 'integry/propr',
      branch: 'release/2026',
      indexing_status: 'indexing',
      progress: {
        phase: 'directories',
        totalDirectories: 20,
        processedDirectories: 15,
        percentComplete: 75
      }
    });

    await act(async () => {
      socketState.indexingHandler?.({
        eventType: 'indexing_update',
        repository: 'integry/propr',
        branch: 'release/2026',
        phase: 'completed',
        timestamp: new Date().toISOString()
      });
    });

    expect(result.current.indexingStatuses['integry/propr:release/2026']).toMatchObject({
      full_name: 'integry/propr',
      branch: 'release/2026',
      indexing_status: 'completed',
      progress: {
        phase: 'completed',
        percentComplete: 100
      }
    });

    await act(async () => {
      socketState.indexingHandler?.({
        eventType: 'indexing_update',
        repository: 'integry/propr',
        branch: 'release/2026',
        phase: 'idle',
        timestamp: new Date().toISOString()
      });
    });

    expect(result.current.indexingStatuses['integry/propr:release/2026']).toMatchObject({
      full_name: 'integry/propr',
      branch: 'release/2026',
      indexing_status: 'idle'
    });
    expect(result.current.indexingStatuses['integry/propr:release/2026'].progress).toBeUndefined();
  });
});

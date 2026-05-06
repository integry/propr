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

  it('keeps optimistic indexing state after a successful reindex trigger until a socket update arrives', async () => {
    const { result } = renderHook(() => useRepositoryManagement());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetRepositoriesIndexingStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.handleReindexRepo('integry/propr', 'release/2026');
    });

    expect(mockGetRepositoriesIndexingStatus).toHaveBeenCalledTimes(1);
    expect(result.current.indexingStatuses['integry/propr:release/2026']).toMatchObject({
      indexing_status: 'indexing',
      branch: 'release/2026'
    });
  });

  it('does not trigger a timer-based refresh after a successful stop request', async () => {
    const { result } = renderHook(() => useRepositoryManagement());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetRepositoriesIndexingStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.handleStopIndexing('integry/propr', 'release/2026');
    });

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(mockGetRepositoriesIndexingStatus).toHaveBeenCalledTimes(1);
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
        totalFiles: 0,
        processedFiles: 0,
        totalDirectories: 0,
        processedDirectories: 0,
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

  it('applies an immediate idle websocket stop event for active jobs', async () => {
    socketState.isConnected = true;

    const { result } = renderHook(() => useRepositoryManagement());

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      socketState.indexingHandler?.({
        eventType: 'indexing_update',
        repository: 'integry/propr',
        branch: 'release/2026',
        phase: 'files',
        progress: 10,
        totalFiles: 100,
        processedFiles: 10,
        timestamp: new Date().toISOString()
      });
    });

    expect(result.current.indexingStatuses['integry/propr:release/2026']).toMatchObject({
      indexing_status: 'indexing'
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
      indexing_status: 'idle'
    });
    expect(result.current.indexingStatuses['integry/propr:release/2026'].progress).toBeUndefined();
  });

  it('ignores late progress events after a terminal websocket update', async () => {
    socketState.isConnected = true;

    const { result } = renderHook(() => useRepositoryManagement());

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.handleReindexRepo('integry/propr', 'release/2026');
    });

    expect(result.current.indexingStatuses['integry/propr:release/2026']).toMatchObject({
      indexing_status: 'indexing'
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

    await act(async () => {
      socketState.indexingHandler?.({
        eventType: 'indexing_update',
        repository: 'integry/propr',
        branch: 'release/2026',
        phase: 'files',
        progress: 20,
        totalFiles: 100,
        processedFiles: 20,
        timestamp: new Date().toISOString()
      });
    });

    expect(result.current.indexingStatuses['integry/propr:release/2026']).toMatchObject({
      indexing_status: 'idle'
    });
    expect(result.current.indexingStatuses['integry/propr:release/2026'].progress).toBeUndefined();
  });

  it('resets completed progress when a new indexing event starts', async () => {
    socketState.isConnected = true;

    mockGetRepositoriesIndexingStatus.mockResolvedValue({
      repositories: [{
        full_name: 'integry/propr',
        branch: 'release/2026',
        indexing_status: 'completed',
        last_indexed_at: null,
        last_indexed_hash: null,
        last_indexed_commit_message: null,
        progress: {
          totalFiles: 100,
          processedFiles: 100,
          percentComplete: 100,
          inputTokens: 0,
          outputTokens: 0,
          phase: 'completed',
          totalDirectories: 20,
          processedDirectories: 20
        }
      }]
    });

    const { result } = renderHook(() => useRepositoryManagement());

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      socketState.indexingHandler?.({
        eventType: 'indexing_update',
        repository: 'integry/propr',
        branch: 'release/2026',
        phase: 'indexing',
        timestamp: new Date().toISOString()
      });
    });

    expect(result.current.indexingStatuses['integry/propr:release/2026']).toMatchObject({
      indexing_status: 'indexing',
      progress: {
        phase: 'files',
        totalFiles: 0,
        processedFiles: 0,
        totalDirectories: 0,
        processedDirectories: 0,
        percentComplete: 0
      }
    });
  });

  it('accepts progress updates after reconnect when the start event was missed', async () => {
    socketState.isConnected = true;

    const { result } = renderHook(() => useRepositoryManagement());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.indexingStatuses['integry/propr:release/2026']).toMatchObject({
      indexing_status: 'idle'
    });

    await act(async () => {
      socketState.indexingHandler?.({
        eventType: 'indexing_update',
        repository: 'integry/propr',
        branch: 'release/2026',
        phase: 'files',
        progress: 20,
        totalFiles: 100,
        processedFiles: 20,
        timestamp: new Date().toISOString()
      });
    });

    expect(result.current.indexingStatuses['integry/propr:release/2026']).toMatchObject({
      indexing_status: 'indexing',
      progress: {
        phase: 'files',
        totalFiles: 100,
        processedFiles: 20,
        percentComplete: 20
      }
    });
  });
});

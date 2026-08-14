import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueueStats, getSystemStatus, getTasks } from '../api/proprApi';
import { getDrafts } from '../api/plannerApi';
import { useHeaderStats } from './useHeaderStats';

vi.mock('../api/proprApi', () => ({
  getQueueStats: vi.fn(),
  getSystemStatus: vi.fn(),
  getTasks: vi.fn(),
}));

vi.mock('../api/plannerApi', () => ({
  getDrafts: vi.fn(),
}));

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: false,
    onTaskUpdate: () => () => undefined,
    onDraftUpdate: () => () => undefined,
  }),
}));

const emptyDrafts = { drafts: [], total: 0, page: 1, limit: 20, hasMore: false };
const healthyStatus = {
  daemon: 'Running',
  workers: [{ id: 1, status: 'active' }],
  redis: 'Connected',
  githubAuth: 'Authenticated',
  claudeAuth: 'Failed',
  indexing: 'Idle',
  githubEventIntake: 'Polling',
  githubEventIntakeStatus: 'Active',
  agents: [],
};

describe('useHeaderStats running activity', () => {
  beforeEach(() => {
    vi.mocked(getDrafts).mockResolvedValue(emptyDrafts);
    vi.mocked(getTasks).mockResolvedValue({ tasks: [] });
    vi.mocked(getSystemStatus).mockResolvedValue(healthyStatus);
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('does not represent historical processing rows without active queue jobs', async () => {
    vi.mocked(getQueueStats).mockResolvedValue({
      active: 0,
      activeJobs: [],
      waiting: 4,
      delayed: 2,
      completed: 0,
      failed: 0,
      paused: 0,
    });
    vi.mocked(getTasks).mockResolvedValue({
      tasks: [{
        id: 'stale-task',
        repository: 'integry/propr',
        title: 'Historical processing row',
        status: 'processing',
        createdAt: '2026-08-01T00:00:00.000Z',
      } as never],
    });

    const { result } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.runningItems).toEqual([]);
    expect(result.current.runningCount).toBe(0);
    expect(getTasks).toHaveBeenCalledTimes(1);
    expect(getTasks).toHaveBeenCalledWith({ limit: 30, forReview: true, excludeMerged: true });
  });

  it('keeps every active job in the list while exposing only proven navigation IDs', async () => {
    vi.mocked(getQueueStats).mockResolvedValue({
      active: 3,
      activeJobs: [
        {
          id: 'job-1',
          taskId: 'task-1',
          name: 'processGitHubIssue',
          title: 'First live task',
          repository: 'integry/propr',
          createdAt: '2026-08-14T20:00:00.000Z',
        },
        {
          id: 'job-2',
          taskId: 'job-2',
          name: 'processPullRequestComment',
          title: 'Second live task',
          repository: 'integry/propr',
          createdAt: '2026-08-14T20:01:00.000Z',
        },
        {
          id: 'parent-job-3',
          name: 'processGitHubIssue',
          title: 'Matrix dispatcher',
          repository: 'integry/propr',
          createdAt: '2026-08-14T20:02:00.000Z',
        },
      ],
      waiting: 7,
      delayed: 3,
      completed: 0,
      failed: 0,
      paused: 0,
    });

    const { result } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.runningItems.map(item => item.id)).toEqual(['parent-job-3', 'job-2', 'job-1']);
    expect(result.current.runningItems.find(item => item.id === 'job-1')?.navigationId).toBe('task-1');
    expect(result.current.runningItems.find(item => item.id === 'parent-job-3')).not.toHaveProperty('navigationId');
    expect(result.current.runningCount).toBe(result.current.runningItems.length);
    expect(result.current.runningCount).toBe(3);
  });

  it('combines generating and refining plans with live jobs without using the augmented active count', async () => {
    vi.mocked(getQueueStats).mockResolvedValue({
      // getQueueStats includes generating plans in this legacy aggregate. The
      // header uses activeJobs instead, so the same plan is not counted twice.
      active: 3,
      activeJobs: [{
        id: 'job-1',
        taskId: 'task-1',
        name: 'processGitHubIssue',
        title: 'Live implementation',
        repository: 'integry/propr',
        createdAt: '2026-08-14T20:02:00.000Z',
      }],
      waiting: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
      paused: 0,
    });
    vi.mocked(getDrafts).mockResolvedValue({
      ...emptyDrafts,
      drafts: [
        {
          draft_id: 'plan-generating',
          repository: 'integry/propr',
          name: 'Generating plan',
          initial_prompt: 'Generate it',
          status: 'generating',
          created_at: '2026-08-14T20:00:00.000Z',
          updated_at: '2026-08-14T20:00:00.000Z',
        },
        {
          draft_id: 'plan-refining',
          repository: 'integry/propr',
          name: 'Refining plan',
          initial_prompt: 'Refine it',
          status: 'refining',
          created_at: '2026-08-14T20:01:00.000Z',
          updated_at: '2026-08-14T20:01:00.000Z',
        },
      ],
    });

    const { result } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.runningItems.map(item => item.id)).toEqual([
      'job-1',
      'plan-refining',
      'plan-generating',
    ]);
    expect(result.current.runningCount).toBe(3);
  });

  it('keeps successful plan activity and surfaces a non-blocking error when queue lookup fails', async () => {
    vi.mocked(getQueueStats).mockRejectedValue(new Error('Live queue unavailable'));
    vi.mocked(getDrafts).mockResolvedValue({
      ...emptyDrafts,
      drafts: [{
        draft_id: 'plan-generating',
        repository: 'integry/propr',
        name: 'Still generating',
        initial_prompt: 'Generate it',
        status: 'generating',
        created_at: '2026-08-14T20:00:00.000Z',
        updated_at: '2026-08-14T20:00:00.000Z',
      }],
    });

    const { result } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.runningItems.map(item => item.id)).toEqual(['plan-generating']);
    expect(result.current.runningCount).toBe(1);
    expect(result.current.error).toBe('Live queue unavailable');
  });
});

import { useState, useEffect, useCallback, useRef } from 'react';
import { getQueueStats, getTasks, getSystemStatus } from '../api/gitfixApi';
import { getDrafts, DraftListItem } from '../api/plannerApi';

// LocalStorage keys for dismissal tracking
const DISMISSED_PLAN_IDS_KEY = 'dismissed_plan_ids';
const DISMISSED_TASK_IDS_KEY = 'dismissed_task_ids';

// Polling interval in milliseconds
const POLLING_INTERVAL = 5000;

interface Task {
  id: string;
  repository?: string;
  repositoryOwner?: string;
  repositoryName?: string;
  issueNumber?: number;
  prNumber?: number;
  title?: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  planIssueStatus?: string | null;
}

interface TaskGroup {
  key: string;
  repoOwner: string;
  repoName: string;
  prNumber?: number;
  issueNumber?: number;
  latestTask: Task;
  allTasks: Task[];
}

interface SystemHealth {
  daemon: string;
  redis: string;
  githubAuth: string;
  claudeAuth: string;
  isHealthy: boolean;
}

export interface HeaderStats {
  // Running tasks count from queue
  runningCount: number;

  // Active plans (not merged, not closed), sorted by updated_at descending
  activePlans: DraftListItem[];

  // Review items count (actionable tasks)
  reviewCount: number;

  // Review task groups for dropdown display
  reviewGroups: TaskGroup[];

  // System health status
  systemHealth: SystemHealth;

  // Loading states
  isLoading: boolean;

  // Error state
  error: string | null;

  // Dismissal functions
  dismissPlan: (planId: string) => void;
  dismissTask: (taskId: string) => void;

  // Get dismissed IDs
  dismissedPlanIds: string[];
  dismissedTaskIds: string[];

  // Clear all dismissals
  clearDismissedPlans: () => void;
  clearDismissedTasks: () => void;

  // Refresh function
  refresh: () => Promise<void>;
}

// Helper to get dismissed IDs from localStorage
const getDismissedIds = (key: string): string[] => {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

// Helper to save dismissed IDs to localStorage
const saveDismissedIds = (key: string, ids: string[]): void => {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    console.error(`Failed to save dismissed IDs to ${key}`);
  }
};

export function useHeaderStats(): HeaderStats {
  const [runningCount, setRunningCount] = useState<number>(0);
  const [activePlans, setActivePlans] = useState<DraftListItem[]>([]);
  const [reviewCount, setReviewCount] = useState<number>(0);
  const [reviewGroups, setReviewGroups] = useState<TaskGroup[]>([]);
  const [systemHealth, setSystemHealth] = useState<SystemHealth>({
    daemon: 'Unknown',
    redis: 'Unknown',
    githubAuth: 'Unknown',
    claudeAuth: 'Unknown',
    isHealthy: false,
  });
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Dismissed IDs state
  const [dismissedPlanIds, setDismissedPlanIds] = useState<string[]>(() => getDismissedIds(DISMISSED_PLAN_IDS_KEY));
  const [dismissedTaskIds, setDismissedTaskIds] = useState<string[]>(() => getDismissedIds(DISMISSED_TASK_IDS_KEY));

  // Track if component is mounted
  const isMountedRef = useRef(true);

  // Dismiss a plan
  const dismissPlan = useCallback((planId: string) => {
    setDismissedPlanIds(prev => {
      const newIds = [...prev, planId];
      saveDismissedIds(DISMISSED_PLAN_IDS_KEY, newIds);
      return newIds;
    });
  }, []);

  // Dismiss a task
  const dismissTask = useCallback((taskId: string) => {
    setDismissedTaskIds(prev => {
      const newIds = [...prev, taskId];
      saveDismissedIds(DISMISSED_TASK_IDS_KEY, newIds);
      return newIds;
    });
  }, []);

  // Clear all dismissed plans
  const clearDismissedPlans = useCallback(() => {
    setDismissedPlanIds([]);
    saveDismissedIds(DISMISSED_PLAN_IDS_KEY, []);
  }, []);

  // Clear all dismissed tasks
  const clearDismissedTasks = useCallback(() => {
    setDismissedTaskIds([]);
    saveDismissedIds(DISMISSED_TASK_IDS_KEY, []);
  }, []);

  // Main fetch function
  const fetchStats = useCallback(async (isInitialLoad = false) => {
    try {
      if (isInitialLoad) {
        setIsLoading(true);
      }

      // Fetch all data in parallel with smart DB-level pre-filtering
      const [queueStats, draftsResponse, tasksResponse, statusResponse] = await Promise.all([
        getQueueStats(),
        // Fetch active plans only (exclude merged and executed at DB level)
        getDrafts({ limit: 20, excludeStatuses: 'merged,executed' }),
        // Fetch review-worthy tasks only (completed/failed, exclude merged at DB level)
        getTasks({ limit: 30, forReview: true, excludeMerged: true }),
        getSystemStatus(),
      ]);

      if (!isMountedRef.current) return;

      // 1. Running count from queue
      setRunningCount(queueStats.active);

      // 2. Process active plans
      // Plans are already pre-filtered at DB level (excludes merged, executed)
      // Only need to filter out manually dismissed plans
      const currentDismissedPlanIds = getDismissedIds(DISMISSED_PLAN_IDS_KEY);
      const filteredPlans = draftsResponse.drafts.filter(draft => {
        return !currentDismissedPlanIds.includes(draft.draft_id);
      });

      // Already sorted by updated_at desc from API, but ensure order
      filteredPlans.sort((a, b) => {
        const dateA = new Date(a.updated_at).getTime();
        const dateB = new Date(b.updated_at).getTime();
        return dateB - dateA;
      });

      setActivePlans(filteredPlans);

      // 3. Process review items
      // Tasks are pre-filtered at DB level (completed/failed only, merged excluded)
      // Group tasks by PR (or issue if no PR)
      const tasks = (tasksResponse as { tasks: Task[] }).tasks || [];
      const currentDismissedTaskIds = getDismissedIds(DISMISSED_TASK_IDS_KEY);

      const groups: Record<string, TaskGroup> = {};

      // Track which issues have PR followup tasks
      // If a PR task exists for an issue, we should filter out the initial issue task
      const prTasksByIssue: Record<string, boolean> = {};

      // First pass: identify issues that have PR followup tasks
      tasks.forEach(task => {
        if (task.prNumber && task.issueNumber) {
          let owner = task.repositoryOwner;
          let name = task.repositoryName;
          if (!owner || !name) {
            const parts = (task.repository || 'unknown/unknown').split('/');
            owner = parts[0] || 'unknown';
            name = parts[1] || 'unknown';
          }
          const issueKey = `${owner}/${name}-issue-${task.issueNumber}`;
          prTasksByIssue[issueKey] = true;
        }
      });

      tasks.forEach(task => {
        // Skip dismissed tasks
        if (currentDismissedTaskIds.includes(task.id)) {
          return;
        }

        let owner = task.repositoryOwner;
        let name = task.repositoryName;

        if (!owner || !name) {
          const parts = (task.repository || 'unknown/unknown').split('/');
          owner = parts[0] || 'unknown';
          name = parts[1] || 'unknown';
        }

        // Create group key: prefer PR number, fallback to issue number
        let key: string;
        if (task.prNumber) {
          key = `${owner}/${name}-pr-${task.prNumber}`;
        } else if (task.issueNumber) {
          key = `${owner}/${name}-issue-${task.issueNumber}`;
          // Skip initial issue tasks if a PR followup exists for this issue
          if (prTasksByIssue[key]) {
            return;
          }
        } else {
          key = task.id;
        }

        if (!groups[key]) {
          groups[key] = {
            key,
            repoOwner: owner,
            repoName: name,
            prNumber: task.prNumber,
            issueNumber: task.issueNumber,
            latestTask: task,
            allTasks: [],
          };
        }

        groups[key].allTasks.push(task);
      });

      // For each group, determine the latest task
      // Since tasks are pre-filtered at DB level, we just need to organize by group
      const reviewableGroups: TaskGroup[] = [];

      Object.values(groups).forEach(group => {
        // Sort tasks by createdAt descending to find the latest
        group.allTasks.sort((a, b) => {
          const dateA = new Date(a.createdAt).getTime();
          const dateB = new Date(b.createdAt).getTime();
          return dateB - dateA;
        });

        const latestTask = group.allTasks[0];
        group.latestTask = latestTask;

        // Tasks are already pre-filtered at DB level to be completed/failed and not merged
        // Just add to reviewable groups
        reviewableGroups.push(group);
      });

      // Sort review groups by latest task's createdAt (newest first)
      reviewableGroups.sort((a, b) => {
        const dateA = new Date(a.latestTask.createdAt).getTime();
        const dateB = new Date(b.latestTask.createdAt).getTime();
        return dateB - dateA;
      });

      setReviewGroups(reviewableGroups);
      setReviewCount(reviewableGroups.length);

      // 4. Process system health
      const health: SystemHealth = {
        daemon: statusResponse.daemon,
        redis: statusResponse.redis,
        githubAuth: statusResponse.githubAuth,
        claudeAuth: statusResponse.claudeAuth,
        isHealthy:
          statusResponse.daemon === 'Running' &&
          statusResponse.redis === 'Connected' &&
          statusResponse.githubAuth === 'Authenticated' &&
          statusResponse.claudeAuth === 'Authenticated',
      };
      setSystemHealth(health);

      setError(null);
    } catch (err) {
      if (!isMountedRef.current) return;
      console.error('Failed to fetch header stats:', err);
      setError((err as Error).message);
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // Refresh function for manual refresh
  const refresh = useCallback(async () => {
    await fetchStats(false);
  }, [fetchStats]);

  // Initial load and polling setup
  useEffect(() => {
    isMountedRef.current = true;

    // Initial fetch
    fetchStats(true);

    // Set up polling
    const intervalId = setInterval(() => {
      fetchStats(false);
    }, POLLING_INTERVAL);

    return () => {
      isMountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [fetchStats]);

  // Re-filter when dismissed IDs change
  useEffect(() => {
    // Trigger a refresh when dismissal state changes
    // This ensures the lists are updated when items are dismissed
    if (!isLoading) {
      fetchStats(false);
    }
  }, [dismissedPlanIds.length, dismissedTaskIds.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    runningCount,
    activePlans,
    reviewCount,
    reviewGroups,
    systemHealth,
    isLoading,
    error,
    dismissPlan,
    dismissTask,
    dismissedPlanIds,
    dismissedTaskIds,
    clearDismissedPlans,
    clearDismissedTasks,
    refresh,
  };
}

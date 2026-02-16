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
  linkedIssueNumber?: number | null;
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

      // Fetch all data in parallel
      const [queueStats, draftsResponse, tasksResponse, statusResponse] = await Promise.all([
        getQueueStats(),
        getDrafts({ limit: 100 }), // Fetch all drafts for client-side filtering
        getTasks('all', 100, 0, 'all', ''), // Fetch recent tasks
        getSystemStatus(),
      ]);

      if (!isMountedRef.current) return;

      // 1. Running count from queue
      setRunningCount(queueStats.active);

      // 2. Process active plans
      // Filter plans where status is NOT 'merged' and NOT 'closed'
      // Also exclude manually dismissed plans
      const currentDismissedPlanIds = getDismissedIds(DISMISSED_PLAN_IDS_KEY);
      const filteredPlans = draftsResponse.drafts.filter(draft => {
        const isActive = draft.status !== 'merged' && draft.status !== 'executed';
        const isNotDismissed = !currentDismissedPlanIds.includes(draft.draft_id);
        return isActive && isNotDismissed;
      });

      // Sort by updated_at descending (newest first)
      filteredPlans.sort((a, b) => {
        const dateA = new Date(a.updated_at).getTime();
        const dateB = new Date(b.updated_at).getTime();
        return dateB - dateA;
      });

      setActivePlans(filteredPlans);

      // 3. Process review items
      // Group tasks by PR (or issue if no PR)
      const tasks = (tasksResponse as { tasks: Task[] }).tasks || [];
      const currentDismissedTaskIds = getDismissedIds(DISMISSED_TASK_IDS_KEY);

      const groups: Record<string, TaskGroup> = {};
      // Track issue-to-PR mapping: when a PR task has linkedIssueNumber,
      // map that issue to the PR for merging groups
      const issueToPrMap: Record<string, string> = {};

      tasks.forEach(task => {
        // Skip dismissed tasks
        if (currentDismissedTaskIds.includes(task.id)) {
          return;
        }

        // Parse repository owner/name
        let owner = task.repositoryOwner;
        let name = task.repositoryName;

        if (!owner || !name) {
          const parts = (task.repository || 'unknown/unknown').split('/');
          owner = parts[0] || 'unknown';
          name = parts[1] || 'unknown';
        }

        const repoPrefix = `${owner}/${name}`;

        // If this task has a PR and a linkedIssueNumber, record the mapping
        // This allows us to merge issue-based groups into PR-based groups
        if (task.prNumber && task.linkedIssueNumber) {
          const issueKey = `${repoPrefix}-issue-${task.linkedIssueNumber}`;
          const prKey = `${repoPrefix}-pr-${task.prNumber}`;
          issueToPrMap[issueKey] = prKey;
        }

        // Create group key: prefer PR number, fallback to issue number
        let key: string;
        if (task.prNumber) {
          key = `${repoPrefix}-pr-${task.prNumber}`;
        } else if (task.issueNumber) {
          key = `${repoPrefix}-issue-${task.issueNumber}`;
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

      // Merge issue-based groups into their corresponding PR groups
      Object.entries(issueToPrMap).forEach(([issueKey, prKey]) => {
        if (groups[issueKey] && groups[prKey]) {
          // Merge issue group tasks into PR group
          groups[prKey].allTasks.push(...groups[issueKey].allTasks);
          // Remove the issue group
          delete groups[issueKey];
        }
      });

      // For each group, determine the latest task and filter based on review criteria
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

        // Auto-removal: If the latest task indicates merged status, exclude the group
        const isMerged = latestTask.status === 'merged' || latestTask.planIssueStatus === 'merged';
        if (isMerged) {
          return; // Skip this group
        }

        // Inclusion criteria:
        // - Include if latest task is 'failed'
        // - Include if latest task is 'completed' AND PR is open (not merged)
        const isFailed = latestTask.status === 'failed';
        const isCompletedAndOpen = latestTask.status === 'completed' && latestTask.planIssueStatus !== 'merged';

        if (isFailed || isCompletedAndOpen) {
          reviewableGroups.push(group);
        }
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

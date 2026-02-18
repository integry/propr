import { useState, useEffect, useCallback, useRef } from 'react';
import { getQueueStats, getTasks, getSystemStatus } from '../api/gitfixApi';
import { getDrafts, DraftListItem } from '../api/plannerApi';
import { useSocket } from '../contexts/useSocket';

// LocalStorage keys for dismissal tracking
const DISMISSED_PLAN_IDS_KEY = 'dismissed_plan_ids';
const DISMISSED_TASK_IDS_KEY = 'dismissed_task_ids';
// New key for tracking PR-based dismissal timestamps
// When a task is dismissed, we store the timestamp for that PR/issue key
// All tasks created before that timestamp for that PR/issue are auto-dismissed
const DISMISSED_TASK_TIMESTAMPS_KEY = 'dismissed_task_timestamps';

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

// Running item interface for AI Activity Monitor
export interface RunningItem {
  id: string;
  type: 'plan' | 'task';
  label: string;
  repository: string;
  status: string;
  createdAt: string;
}

// Map of PR/issue keys to dismissal timestamps
// When a task group is dismissed, all tasks created before that timestamp are hidden
interface DismissedTaskTimestamps {
  [key: string]: number; // key format: "owner/repo-pr-123" or "owner/repo-issue-456", value: timestamp in ms
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

  // Running items for AI Activity Monitor dropdown
  runningItems: RunningItem[];

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
  // Dismiss a task group - stores timestamp to auto-dismiss older followup tasks
  dismissTask: (taskGroupKey: string, latestTaskCreatedAt: string) => void;

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

// Helper to get dismissed task timestamps from localStorage
const getDismissedTaskTimestamps = (): DismissedTaskTimestamps => {
  try {
    const stored = localStorage.getItem(DISMISSED_TASK_TIMESTAMPS_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
};

// Helper to save dismissed task timestamps to localStorage
const saveDismissedTaskTimestamps = (timestamps: DismissedTaskTimestamps): void => {
  try {
    localStorage.setItem(DISMISSED_TASK_TIMESTAMPS_KEY, JSON.stringify(timestamps));
  } catch {
    console.error('Failed to save dismissed task timestamps');
  }
};

// Helper to create a task group key for dismissal tracking
const getTaskGroupKey = (repoOwner: string, repoName: string, prNumber?: number, issueNumber?: number): string => {
  const repoPrefix = `${repoOwner}/${repoName}`;
  if (prNumber) {
    return `${repoPrefix}-pr-${prNumber}`;
  } else if (issueNumber) {
    return `${repoPrefix}-issue-${issueNumber}`;
  }
  return '';
};

export function useHeaderStats(): HeaderStats {
  const [runningCount, setRunningCount] = useState<number>(0);
  const [runningItems, setRunningItems] = useState<RunningItem[]>([]);
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
  // Track dismissal timestamps per PR/issue key for auto-dismissing older followup tasks
  const [dismissedTaskTimestamps, setDismissedTaskTimestamps] = useState<DismissedTaskTimestamps>(() => getDismissedTaskTimestamps());

  // Track if component is mounted
  const isMountedRef = useRef(true);

  // WebSocket connection for real-time updates
  const { onTaskUpdate, onDraftUpdate, isConnected } = useSocket();

  // Dismiss a plan
  const dismissPlan = useCallback((planId: string) => {
    setDismissedPlanIds(prev => {
      const newIds = [...prev, planId];
      saveDismissedIds(DISMISSED_PLAN_IDS_KEY, newIds);
      return newIds;
    });
  }, []);

  // Dismiss a task group - stores both the task ID and a timestamp for the PR/issue key
  // This ensures older followup tasks are automatically dismissed
  const dismissTask = useCallback((taskGroupKey: string, latestTaskCreatedAt: string) => {
    // Store the timestamp for this PR/issue key
    // Any tasks created at or before this timestamp for this key will be auto-dismissed
    const dismissTimestamp = new Date(latestTaskCreatedAt).getTime();

    setDismissedTaskTimestamps(prev => {
      const newTimestamps = { ...prev, [taskGroupKey]: dismissTimestamp };
      saveDismissedTaskTimestamps(newTimestamps);
      return newTimestamps;
    });

    // Also store the task group key in dismissedTaskIds for backwards compatibility
    setDismissedTaskIds(prev => {
      const newIds = [...prev, taskGroupKey];
      saveDismissedIds(DISMISSED_TASK_IDS_KEY, newIds);
      return newIds;
    });
  }, []);

  // Clear all dismissed plans
  const clearDismissedPlans = useCallback(() => {
    setDismissedPlanIds([]);
    saveDismissedIds(DISMISSED_PLAN_IDS_KEY, []);
  }, []);

  // Clear all dismissed tasks (including timestamps)
  const clearDismissedTasks = useCallback(() => {
    setDismissedTaskIds([]);
    saveDismissedIds(DISMISSED_TASK_IDS_KEY, []);
    setDismissedTaskTimestamps({});
    saveDismissedTaskTimestamps({});
  }, []);

  // Main fetch function
  const fetchStats = useCallback(async (isInitialLoad = false) => {
    try {
      if (isInitialLoad) {
        setIsLoading(true);
      }

      // Fetch all data in parallel with smart DB-level pre-filtering
      const [_queueStats, draftsResponse, tasksResponse, processingTasksResponse, statusResponse] = await Promise.all([
        getQueueStats(),
        // Fetch active plans only (exclude merged at DB level - include executed and pr_created for Plans in Focus)
        getDrafts({ limit: 20, excludeStatuses: 'merged' }),
        // Fetch review-worthy tasks only (completed/failed, exclude merged at DB level)
        getTasks({ limit: 30, forReview: true, excludeMerged: true }),
        // Fetch processing tasks for the AI Activity Monitor
        getTasks({ status: 'processing', limit: 20 }),
        getSystemStatus(),
      ]);

      if (!isMountedRef.current) return;

      // 1. Build running items list for AI Activity Monitor
      const runningItemsList: RunningItem[] = [];

      // Add generating/refining plans
      const generatingPlans = draftsResponse.drafts.filter(
        (draft) => draft.status === 'generating' || draft.status === 'refining'
      );
      generatingPlans.forEach((plan) => {
        runningItemsList.push({
          id: plan.draft_id,
          type: 'plan',
          label: plan.name || plan.initial_prompt || 'Generating Plan',
          repository: plan.repository,
          status: plan.status === 'generating' ? 'Generating Spec' : 'Refining',
          createdAt: plan.created_at,
        });
      });

      // Add processing tasks
      const processingTasks = (processingTasksResponse as { tasks: Task[] }).tasks || [];
      processingTasks.forEach((task) => {
        runningItemsList.push({
          id: task.id,
          type: 'task',
          label: task.title || `Task ${task.id.slice(0, 8)}`,
          repository: task.repository || `${task.repositoryOwner || 'unknown'}/${task.repositoryName || 'unknown'}`,
          status: 'Implementing',
          createdAt: task.createdAt,
        });
      });

      // Sort by createdAt descending (newest first)
      runningItemsList.sort((a, b) => {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });

      setRunningItems(runningItemsList);
      // Running count should match the actual running items to ensure consistency
      setRunningCount(runningItemsList.length);

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
      const currentDismissedTimestamps = getDismissedTaskTimestamps();

      const groups: Record<string, TaskGroup> = {};
      // Track issue-to-PR mapping: when a PR task has linkedIssueNumber,
      // map that issue to the PR for merging groups
      const issueToPrMap: Record<string, string> = {};

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
        let owner = task.repositoryOwner;
        let name = task.repositoryName;

        if (!owner || !name) {
          const parts = (task.repository || 'unknown/unknown').split('/');
          owner = parts[0] || 'unknown';
          name = parts[1] || 'unknown';
        }

        const repoPrefix = `${owner}/${name}`;

        // Create group key: prefer PR number, fallback to issue number
        const taskGroupKey = getTaskGroupKey(owner, name, task.prNumber, task.issueNumber) || task.id;

        // Skip dismissed tasks using timestamp-based filtering
        // If this PR/issue key has a dismissal timestamp, only show tasks created AFTER that timestamp
        const dismissedTimestamp = currentDismissedTimestamps[taskGroupKey];
        if (dismissedTimestamp) {
          const taskCreatedAt = new Date(task.createdAt).getTime();
          // Skip tasks created at or before the dismissal timestamp
          if (taskCreatedAt <= dismissedTimestamp) {
            return;
          }
        }

        // Also check legacy dismissal by task ID for backwards compatibility
        if (currentDismissedTaskIds.includes(task.id)) {
          return;
        }

        // If this task has a PR and a linkedIssueNumber, record the mapping
        // This allows us to merge issue-based groups into PR-based groups
        if (task.prNumber && task.linkedIssueNumber) {
          const issueKey = `${repoPrefix}-issue-${task.linkedIssueNumber}`;
          const prKey = `${repoPrefix}-pr-${task.prNumber}`;
          issueToPrMap[issueKey] = prKey;
        }

        // Use the already-computed group key (taskGroupKey is already computed above)
        const key = taskGroupKey;

        // Skip initial issue tasks if a PR followup exists for this issue
        if (!task.prNumber && task.issueNumber && prTasksByIssue[key]) {
          return;
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

      // For each group, determine the latest task
      // Tasks are pre-filtered at DB level, we just need to organize by group
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

  // Initial load
  useEffect(() => {
    isMountedRef.current = true;

    // Initial fetch
    fetchStats(true);

    return () => {
      isMountedRef.current = false;
    };
  }, [fetchStats]);

  // Subscribe to WebSocket events for real-time updates
  useEffect(() => {
    if (!isConnected) return;

    // Handle task updates - refresh stats when any task changes state
    const handleTaskUpdate = () => {
      console.log('[useHeaderStats] Received task update, refreshing stats');
      fetchStats(false);
    };

    // Handle draft updates - refresh stats when drafts change (affects active plans)
    const handleDraftUpdate = () => {
      console.log('[useHeaderStats] Received draft update, refreshing stats');
      fetchStats(false);
    };

    // Subscribe to task and draft updates
    const unsubscribeTask = onTaskUpdate(handleTaskUpdate);
    const unsubscribeDraft = onDraftUpdate(handleDraftUpdate);

    return () => {
      unsubscribeTask();
      unsubscribeDraft();
    };
  }, [isConnected, onTaskUpdate, onDraftUpdate, fetchStats]);

  // Re-filter when dismissed IDs or timestamps change
  useEffect(() => {
    // Trigger a refresh when dismissal state changes
    // This ensures the lists are updated when items are dismissed
    if (!isLoading) {
      fetchStats(false);
    }
  }, [dismissedPlanIds.length, dismissedTaskIds.length, Object.keys(dismissedTaskTimestamps).length]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    runningCount,
    runningItems,
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

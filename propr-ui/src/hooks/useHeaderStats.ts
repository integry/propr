/* eslint-disable max-lines -- stateful header projections stay together so partial refreshes commit atomically */
import { useState, useEffect, useCallback, useRef } from 'react';
import { getQueueStats, getTasks } from '../api/proprApi';
import { getDrafts, DraftListItem } from '../api/plannerApi';
import { useSocket } from '../contexts/useSocket';
import { isDesktopRuntime } from '../config/runtimeMode';
import type { DraftUpdatePayload, QueueStatsUpdatePayload, TaskUpdatePayload } from '@propr/shared';
import { useCurrentUser } from '../contexts/AuthContext';
import { getDesktopSocketConfigurationKey } from '../api/apiClient';
import { useSharedSystemStatus } from '../contexts/SystemStatusContext';
import type { SystemStatus } from '../api/proprTypes';
import {
  coalesceHeaderStatsRead,
  type HeaderStatsResource,
} from './headerStatsRequestCoordinator';
import {
  buildReviewGroups,
  buildRunningItems,
  buildSystemHealth,
  DISMISSED_PLAN_IDS_KEY,
  DISMISSED_TASK_IDS_KEY,
  filterActivePlans,
  getDismissedIds,
  getDismissedTaskTimestamps,
  saveDismissedIds,
  saveDismissedTaskTimestamps,
} from './useHeaderStatsHelpers';
import type {
  DismissedTaskTimestamps,
  RunningItem,
  SystemHealth,
  TaskGroup,
} from './useHeaderStatsHelpers';

export type { RunningItem } from './useHeaderStatsHelpers';

const LIVE_INVALIDATION_COALESCE_MS = 100;
const LIVE_REVALIDATION_RETRY_DELAYS_MS = [1_000, 3_000] as const;
const FALLBACK_POLL_INTERVAL_MS = 30_000;
const ALL_STATS_RESOURCES: readonly HeaderStatsResource[] = ['queue', 'drafts', 'tasks', 'status'];

export type HeaderStatsResourceStatus = 'checking' | 'available' | 'unavailable';

type ResourceRecord<T> = Record<HeaderStatsResource, T>;

interface FetchStatsResult {
  succeededResources: HeaderStatsResource[];
  failedResources: HeaderStatsResource[];
  supersededResources: HeaderStatsResource[];
}

const createResourceRecord = <T,>(value: T): ResourceRecord<T> => ({
  queue: value,
  drafts: value,
  tasks: value,
  status: value,
});

const getActivityStatus = (
  statuses: ResourceRecord<HeaderStatsResourceStatus>,
): HeaderStats['activityStatus'] => {
  const activityStatuses = [statuses.queue, statuses.drafts];
  if (activityStatuses.includes('unavailable')) return 'unavailable';
  if (activityStatuses.every(status => status === 'available')) return 'available';
  return 'checking';
};

const queueStatsFingerprint = (payload: QueueStatsUpdatePayload): string => JSON.stringify([
  payload.stats.waiting,
  payload.stats.active,
  payload.stats.activeGoals ?? 0,
  payload.stats.completed,
  payload.stats.failed,
  payload.stats.delayed,
  payload.stats.total,
]);

export interface HeaderStats {
  // Running tasks count from queue
  runningCount: number;

  // Running items for AI Activity Monitor dropdown
  runningItems: RunningItem[];

  // Whether the active-work snapshot is current and complete.
  activityStatus: 'checking' | 'available' | 'unavailable';

  // Whether each independently reconciled header resource has loaded.
  resourceStatuses: ResourceRecord<HeaderStatsResourceStatus>;

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

export function useHeaderStats(): HeaderStats {
  const currentUser = useCurrentUser();
  const { getStatus, refreshStatus } = useSharedSystemStatus();
  const requestIdentityKey = `${getDesktopSocketConfigurationKey()}\0${currentUser?.id ?? 'anonymous'}`;
  const [runningCount, setRunningCount] = useState<number>(0);
  const [runningItems, setRunningItems] = useState<RunningItem[]>([]);
  const [resourceStatuses, setResourceStatuses] = useState<ResourceRecord<HeaderStatsResourceStatus>>(
    () => createResourceRecord('checking'),
  );
  const [activePlans, setActivePlans] = useState<DraftListItem[]>([]);
  const [reviewCount, setReviewCount] = useState<number>(0);
  const [reviewGroups, setReviewGroups] = useState<TaskGroup[]>([]);
  const [systemHealth, setSystemHealth] = useState<SystemHealth>({
    daemon: 'Unknown',
    workers: 'Unknown',
    redis: 'Unknown',
    githubAuth: 'Unknown',
    claudeAuth: 'Unknown',
    indexing: 'Unknown',
    githubEventIntake: 'Unknown',
    githubEventIntakeStatus: 'Unknown',
    agents: [],
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
  const statsRequestRef = useRef<ResourceRecord<number>>(createResourceRecord(0));
  const resourceErrorsRef = useRef<ResourceRecord<string | null>>(createResourceRecord(null));
  const liveRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRefreshInFlightRef = useRef(false);
  const liveRefreshPendingRef = useRef<Set<HeaderStatsResource>>(new Set());
  const liveRefreshRetryAttemptRef = useRef(0);
  const lastQueueStatsFingerprintRef = useRef<string | null>(null);
  const pendingQueueStatsFingerprintRef = useRef<string | null>(null);
  const draftsSnapshotRef = useRef<DraftListItem[]>([]);
  const activeJobsSnapshotRef = useRef<Awaited<ReturnType<typeof getQueueStats>>['activeJobs']>([]);
  const tasksSnapshotRef = useRef<Awaited<ReturnType<typeof getTasks>>>({ tasks: [] });
  const draftStatusesRef = useRef<Map<string, string>>(new Map());
  const taskFingerprintsRef = useRef<Map<string, string>>(new Map());
  const previousRequestIdentityRef = useRef(requestIdentityKey);
  const requestIdentityRef = useRef(requestIdentityKey);

  // WebSocket connection for real-time updates
  const { onTaskUpdate, onDraftUpdate, onQueueStatsUpdate, isConnected } = useSocket();
  const socketConnectedRef = useRef(isConnected);
  socketConnectedRef.current = isConnected;

  // A mounted desktop renderer can switch instances/accounts without a page
  // reload. Drop every account-derived snapshot before starting reads under
  // the new coalescing key.
  useEffect(() => {
    if (previousRequestIdentityRef.current === requestIdentityKey) return;
    previousRequestIdentityRef.current = requestIdentityKey;
    requestIdentityRef.current = requestIdentityKey;
    ALL_STATS_RESOURCES.forEach(resource => { statsRequestRef.current[resource] += 1; });
    resourceErrorsRef.current = createResourceRecord(null);
    draftsSnapshotRef.current = [];
    activeJobsSnapshotRef.current = [];
    tasksSnapshotRef.current = { tasks: [] };
    draftStatusesRef.current.clear();
    taskFingerprintsRef.current.clear();
    lastQueueStatsFingerprintRef.current = null;
    pendingQueueStatsFingerprintRef.current = null;
    setRunningItems([]);
    setRunningCount(0);
    setActivePlans([]);
    setReviewGroups([]);
    setReviewCount(0);
    setResourceStatuses(createResourceRecord('checking'));
    setIsLoading(true);
    setError(null);
  }, [requestIdentityKey]);

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
  // Partial reconciliation has several deliberately independent failure paths.
  /* eslint-disable complexity */
  const fetchStats = useCallback(
  async (
    resources: readonly HeaderStatsResource[] = ALL_STATS_RESOURCES,
    isInitialLoad = false,
  ): Promise<FetchStatsResult> => {
    const requestIdentity = requestIdentityKey;
    const requestVersions = new Map(resources.map(resource => {
      const version = statsRequestRef.current[resource] + 1;
      statsRequestRef.current[resource] = version;
      return [resource, version] as const;
    }));
    try {
      if (isInitialLoad) {
        setIsLoading(true);
      }

      const requested = new Set(resources);
      const reads = {
        queue: requested.has('queue')
          ? coalesceHeaderStatsRead(requestIdentityKey, 'queue', getQueueStats) : null,
        drafts: requested.has('drafts')
          ? coalesceHeaderStatsRead(requestIdentityKey, 'drafts', () =>
            getDrafts({ limit: 20, excludeStatuses: 'merged' })) : null,
        tasks: requested.has('tasks')
          ? coalesceHeaderStatsRead(requestIdentityKey, 'tasks', () =>
            getTasks({ limit: 30, forReview: true, excludeMerged: true })) : null,
        status: requested.has('status')
          ? coalesceHeaderStatsRead(requestIdentityKey, 'status', isInitialLoad ? getStatus : refreshStatus) : null,
      };
      const entries = await Promise.all((Object.entries(reads) as Array<[
        HeaderStatsResource, Promise<unknown> | null
      ]>).filter((entry): entry is [HeaderStatsResource, Promise<unknown>] => entry[1] !== null)
        .map(async ([resource, promise]) => {
          try {
            return [resource, await promise, null] as const;
          } catch (error) {
            return [resource, null, error as Error] as const;
          }
        }));

      if (!isMountedRef.current || requestIdentityRef.current !== requestIdentity) {
        return {
          succeededResources: [],
          failedResources: [],
          supersededResources: [...resources],
        };
      }

      const result: FetchStatsResult = {
        succeededResources: [],
        failedResources: [],
        supersededResources: [],
      };
      for (const [resource, value, resourceError] of entries) {
        if (requestVersions.get(resource) !== statsRequestRef.current[resource]) {
          result.supersededResources.push(resource);
          continue;
        }
        if (resourceError) {
          resourceErrorsRef.current[resource] = resourceError.message;
          result.failedResources.push(resource);
          setResourceStatuses(previous => ({ ...previous, [resource]: 'unavailable' }));
          continue;
        }
        resourceErrorsRef.current[resource] = null;
        result.succeededResources.push(resource);
        setResourceStatuses(previous => ({
          ...previous,
          [resource]: resource === 'queue' && isDesktopRuntime() && !socketConnectedRef.current
            ? 'unavailable'
            : 'available',
        }));
        if (resource === 'queue') {
          const queue = value as Awaited<ReturnType<typeof getQueueStats>>;
          activeJobsSnapshotRef.current = queue.activeJobs || [];
          if (pendingQueueStatsFingerprintRef.current !== null) {
            lastQueueStatsFingerprintRef.current = pendingQueueStatsFingerprintRef.current;
            pendingQueueStatsFingerprintRef.current = null;
          }
        } else if (resource === 'drafts') {
          const response = value as Awaited<ReturnType<typeof getDrafts>>;
          draftsSnapshotRef.current = response.drafts;
          draftStatusesRef.current = new Map(response.drafts.map(draft => [draft.draft_id, draft.status]));
          setActivePlans(filterActivePlans(response.drafts));
        } else if (resource === 'tasks') {
          const response = value as Awaited<ReturnType<typeof getTasks>>;
          tasksSnapshotRef.current = response;
          for (const task of response.tasks) {
            taskFingerprintsRef.current.set(task.id, `${task.status}\0${task.repository ?? ''}\0${task.issueNumber ?? ''}`);
          }
          const reviewableGroups = buildReviewGroups(response);
          setReviewGroups(reviewableGroups);
          setReviewCount(reviewableGroups.length);
        } else {
          setSystemHealth(buildSystemHealth(value as SystemStatus));
        }
      }

      if (result.succeededResources.some(resource => resource === 'queue' || resource === 'drafts')) {
        const runningItemsList = buildRunningItems(
          draftsSnapshotRef.current,
          activeJobsSnapshotRef.current || [],
        );
        setRunningItems(runningItemsList);
        setRunningCount(runningItemsList.length);
      }
      setError(ALL_STATS_RESOURCES
        .map(resource => resourceErrorsRef.current[resource])
        .find((message): message is string => message !== null) ?? null);
      return result;
    } catch (err) {
      if (!isMountedRef.current || requestIdentityRef.current !== requestIdentity) {
        return {
          succeededResources: [],
          failedResources: [],
          supersededResources: [...resources],
        };
      }
      console.error('Failed to fetch header stats:', err);
      const failedResources = resources.filter(resource =>
        requestVersions.get(resource) === statsRequestRef.current[resource]);
      failedResources.forEach(resource => {
        resourceErrorsRef.current[resource] = (err as Error).message;
      });
      setResourceStatuses(previous => failedResources.reduce((next, resource) => ({
        ...next,
        [resource]: 'unavailable',
      }), previous));
      setError((err as Error).message);
      return {
        succeededResources: [],
        failedResources,
        supersededResources: resources.filter(resource => !failedResources.includes(resource)),
      };
    } finally {
      if (isInitialLoad
        && isMountedRef.current
        && requestIdentityRef.current === requestIdentity) {
        setIsLoading(false);
      }
    }
  }, [getStatus, refreshStatus, requestIdentityKey]);
  /* eslint-enable complexity */

  // Refresh function for manual refresh
  const refresh = useCallback(async () => {
    await fetchStats(ALL_STATS_RESOURCES, false);
  }, [fetchStats]);

  // Queue, task, and draft transitions are often emitted together. Collect the
  // affected resources and reconcile each at most once after the burst.
  const scheduleLiveRefresh = useCallback((resources: readonly HeaderStatsResource[] = ALL_STATS_RESOURCES) => {
    resources.forEach(resource => liveRefreshPendingRef.current.add(resource));
    if (document.visibilityState === 'hidden') return;
    if (liveRefreshTimerRef.current !== null || liveRefreshInFlightRef.current) return;

    const armRefresh = (delayMs: number) => {
      liveRefreshTimerRef.current = setTimeout(async () => {
        liveRefreshTimerRef.current = null;
        if (!isMountedRef.current || liveRefreshPendingRef.current.size === 0) return;

        const pendingResources = [...liveRefreshPendingRef.current];
        liveRefreshPendingRef.current.clear();
        liveRefreshInFlightRef.current = true;
        const outcome = await fetchStats(pendingResources, false);
        liveRefreshInFlightRef.current = false;

        if (!isMountedRef.current) return;
        if (outcome.failedResources.length === 0) {
          liveRefreshRetryAttemptRef.current = 0;
        } else if (socketConnectedRef.current
          && liveRefreshRetryAttemptRef.current < LIVE_REVALIDATION_RETRY_DELAYS_MS.length) {
          const retryDelay = LIVE_REVALIDATION_RETRY_DELAYS_MS[liveRefreshRetryAttemptRef.current];
          liveRefreshRetryAttemptRef.current += 1;
          outcome.failedResources.forEach(resource => liveRefreshPendingRef.current.add(resource));
          if (document.visibilityState !== 'hidden') armRefresh(retryDelay);
        } else {
          liveRefreshRetryAttemptRef.current = 0;
          if (outcome.failedResources.includes('queue')) {
            pendingQueueStatsFingerprintRef.current = null;
          }
        }

        if (liveRefreshPendingRef.current.size > 0
          && liveRefreshTimerRef.current === null
          && document.visibilityState !== 'hidden') {
          armRefresh(LIVE_INVALIDATION_COALESCE_MS);
        }
      }, delayMs);
    };

    armRefresh(LIVE_INVALIDATION_COALESCE_MS);
  }, [fetchStats]);

  // A reconnect can carry a forced queue snapshot whose counts match the last
  // payload even though drafts, tasks, or health changed while offline. Reset
  // queue dedup for every runtime and reconcile one authoritative snapshot.
  // Desktop additionally invalidates cached activity while its scoped socket is
  // disconnected.
  const previousSocketConnectionRef = useRef<boolean | null>(null);
  useEffect(() => {
    const previous = previousSocketConnectionRef.current;
    previousSocketConnectionRef.current = isConnected;
    if (!isConnected) {
      if (liveRefreshTimerRef.current !== null) {
        clearTimeout(liveRefreshTimerRef.current);
        liveRefreshTimerRef.current = null;
      }
      liveRefreshPendingRef.current.clear();
      liveRefreshRetryAttemptRef.current = 0;
      pendingQueueStatsFingerprintRef.current = null;
      lastQueueStatsFingerprintRef.current = null;
      ALL_STATS_RESOURCES.forEach(resource => { statsRequestRef.current[resource] += 1; });
      if (isDesktopRuntime()) {
        setRunningItems([]);
        setRunningCount(0);
        setResourceStatuses(previous => ({ ...previous, queue: 'unavailable' }));
        setIsLoading(false);
      }
      return;
    }
    if (previous === false) {
      lastQueueStatsFingerprintRef.current = null;
      pendingQueueStatsFingerprintRef.current = null;
      liveRefreshRetryAttemptRef.current = 0;
      if (isDesktopRuntime()) {
        setResourceStatuses(previous => ({ ...previous, queue: 'checking' }));
      }
      scheduleLiveRefresh(ALL_STATS_RESOURCES);
    }
  }, [isConnected, scheduleLiveRefresh]);

  // Initial load
  useEffect(() => {
    isMountedRef.current = true;
    const pendingResources = liveRefreshPendingRef.current;

    // Initial fetch
    const initialResources = ALL_STATS_RESOURCES;
    if (document.visibilityState === 'hidden') {
      initialResources.forEach(resource => liveRefreshPendingRef.current.add(resource));
    } else {
      void fetchStats(initialResources, true).then(outcome => {
        if (outcome.failedResources.length > 0 && socketConnectedRef.current) {
          scheduleLiveRefresh(outcome.failedResources);
        }
      });
    }

    return () => {
      isMountedRef.current = false;
      if (liveRefreshTimerRef.current !== null) {
        clearTimeout(liveRefreshTimerRef.current);
        liveRefreshTimerRef.current = null;
      }
      pendingResources.clear();
    };
  }, [fetchStats, scheduleLiveRefresh]);

  // Subscribe to WebSocket events for real-time updates
  useEffect(() => {
    if (!isConnected) return;

    // Handle task updates - refresh stats when any task changes state
    const handleTaskUpdate = (payload: TaskUpdatePayload) => {
      const state = payload.state.toLowerCase();
      const previousState = payload.previousState?.toLowerCase();
      const fingerprint = `${state}\0${payload.repository ?? ''}\0${payload.issueNumber ?? ''}`;
      if (taskFingerprintsRef.current.get(payload.taskId) === fingerprint) return;
      taskFingerprintsRef.current.set(payload.taskId, fingerprint);
      const reviewStates = new Set(['completed', 'failed']);
      const identityChanged = payload.metadata?.issueRefUpdated === true;
      if (!identityChanged && !reviewStates.has(state) && !reviewStates.has(previousState ?? '')) return;
      scheduleLiveRefresh(['tasks']);
    };

    // Handle draft updates - refresh stats when drafts change (affects active plans)
    const handleDraftUpdate = (payload: DraftUpdatePayload) => {
      if (!payload.draftStatus) return;
      const previousStatus = draftStatusesRef.current.get(payload.draftId);
      if (previousStatus === payload.draftStatus) return;
      draftStatusesRef.current.set(payload.draftId, payload.draftStatus);
      scheduleLiveRefresh(['drafts']);
    };

    const handleQueueStatsUpdate = (payload: QueueStatsUpdatePayload) => {
      const fingerprint = queueStatsFingerprint(payload);
      if (fingerprint === lastQueueStatsFingerprintRef.current
        || fingerprint === pendingQueueStatsFingerprintRef.current) return;
      pendingQueueStatsFingerprintRef.current = fingerprint;
      console.log('[useHeaderStats] Received changed queue stats, scheduling stats refresh');
      scheduleLiveRefresh(['queue']);
    };

    // Subscribe to every event that can change active work.
    const unsubscribeTask = onTaskUpdate(handleTaskUpdate);
    const unsubscribeDraft = onDraftUpdate(handleDraftUpdate);
    const unsubscribeQueueStats = onQueueStatsUpdate(handleQueueStatsUpdate);

    return () => {
      unsubscribeTask();
      unsubscribeDraft();
      unsubscribeQueueStats();
    };
  }, [isConnected, onTaskUpdate, onDraftUpdate, onQueueStatsUpdate, scheduleLiveRefresh]);

  // Hidden tabs accumulate invalidations without issuing requests. Becoming
  // visible (or receiving focus after a suspended socket) performs one full
  // recovery snapshot. A disconnected visible tab keeps a bounded HTTP
  // fallback so the UI cannot remain stale forever.
  useEffect(() => {
    const recoverVisible = () => {
      if (document.visibilityState !== 'hidden') scheduleLiveRefresh(ALL_STATS_RESOURCES);
    };
    const fallbackPoll = window.setInterval(() => {
      if (!socketConnectedRef.current && document.visibilityState !== 'hidden') {
        scheduleLiveRefresh(ALL_STATS_RESOURCES);
      }
    }, FALLBACK_POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', recoverVisible);
    window.addEventListener('focus', recoverVisible);
    return () => {
      window.clearInterval(fallbackPoll);
      document.removeEventListener('visibilitychange', recoverVisible);
      window.removeEventListener('focus', recoverVisible);
    };
  }, [scheduleLiveRefresh]);

  // Re-filter when dismissed IDs or timestamps change
  useEffect(() => {
    if (!isLoading) {
      setActivePlans(filterActivePlans(draftsSnapshotRef.current));
      const reviewableGroups = buildReviewGroups(tasksSnapshotRef.current);
      setReviewGroups(reviewableGroups);
      setReviewCount(reviewableGroups.length);
    }
  }, [dismissedPlanIds.length, dismissedTaskIds.length, Object.keys(dismissedTaskTimestamps).length]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    runningCount,
    runningItems,
    activityStatus: getActivityStatus(resourceStatuses),
    resourceStatuses,
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

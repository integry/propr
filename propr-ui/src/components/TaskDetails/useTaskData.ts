import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getTaskHistory, getTaskLiveDetails,
  stopTaskExecution, StopExecutionResponse, deleteTask
} from '../../api/proprApi';
import { HistoryItem, TaskInfo, LiveDetails, LiveEvent, TodoItem, UsageMetricRecord } from './types';
import { useToast } from '../ui/useToast';
import { useSocket } from '../../contexts/useSocket';
import { trustedPreviewMedia, type PublishedVisualPreview, type TaskUpdatePayload, type TaskLiveUpdatePayload } from '@propr/shared';
import { useLiveRefreshScheduler } from '../../hooks/useLiveRefreshScheduler';
import { useCurrentUser } from '../../contexts/AuthContext';
import {
  capLiveEvents, executionSupersededByRead, isFinishedTask, isSupersededUpdate, mergeFullLiveDetails, readCoversUpdate,
} from './liveDetailsMerge';
import { getDesktopSocketConfigurationKey } from '../../api/apiClient';
export { capLiveEvents, MAX_LIVE_RAW_EVENTS, mergeFullLiveDetails } from './liveDetailsMerge';

interface TaskHistoryData {
  history?: HistoryItem[];
  taskInfo?: TaskInfo | null;
  usageMetricRecords?: UsageMetricRecord[];
  previewMedia?: PublishedVisualPreview[];
}

const normalizeTodoStatus = (status: string): TodoItem['status'] => {
  if (status === 'in_progress' || status === 'completed') return status;
  return 'pending';
};

const stableTodoContentId = (content: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `todo-${(hash >>> 0).toString(36)}`;
};

export const normalizeLiveTodos = (todos: TaskLiveUpdatePayload['todos']): TodoItem[] => {
  const occurrences = new Map<string, number>();
  return todos.map(todo => {
    const baseId = todo.id?.trim() || stableTodoContentId(todo.content);
    const occurrence = occurrences.get(baseId) ?? 0;
    occurrences.set(baseId, occurrence + 1);
    return {
      id: occurrence === 0 ? baseId : `${baseId}-${occurrence}`,
      content: todo.content,
      status: normalizeTodoStatus(todo.status)
    };
  });
};

const legacyEventFingerprint = (event: LiveDetails['events'][number]) => {
  // A tool use and its result intentionally share toolUseId, so retain the
  // event type while still distinguishing otherwise identical tool calls.
  if (event.toolUseId) return `tool:${JSON.stringify({
    type: event.type,
    toolUseId: event.toolUseId,
    timestamp: event.timestamp,
    toolName: event.toolName,
    input: event.input,
    result: event.result,
    isError: event.isError,
  })}`;
  return `legacy:${JSON.stringify({
    type: event.type,
    content: event.content,
    timestamp: event.timestamp,
    toolName: event.toolName,
    input: event.input,
    result: event.result,
    isError: event.isError,
  })}`;
};

/**
 * Appends events not seen yet and updates events whose content changed (a
 * buffered assistant message keeps its ID while it grows).
 */
const appendUniqueEvents = (
  currentEvents: LiveDetails['events'],
  newEvents: LiveDetails['events']
) => {
  if (newEvents.length === 0) return currentEvents;
  const indexById = new Map<string, number>();
  currentEvents.forEach((event, index) => { if (event.id) indexById.set(event.id, index); });
  const existingLegacyOccurrences = new Map<string, number>();
  for (const event of currentEvents) {
    if (event.id) continue;
    const fingerprint = legacyEventFingerprint(event);
    existingLegacyOccurrences.set(fingerprint, (existingLegacyOccurrences.get(fingerprint) ?? 0) + 1);
  }
  let updated: LiveDetails['events'] | null = null;
  const incomingLegacyOccurrences = new Map<string, number>();
  const uniqueNewEvents = newEvents.filter(event => {
    if (event.id) {
      const existing = indexById.get(event.id);
      if (existing === undefined) {
        indexById.set(event.id, -1);
        return true;
      }
      if (existing >= 0 && currentEvents[existing] !== event) {
        updated ??= [...currentEvents];
        updated[existing] = event;
      }
      return false;
    }
    const fingerprint = legacyEventFingerprint(event);
    const occurrence = incomingLegacyOccurrences.get(fingerprint) ?? 0;
    incomingLegacyOccurrences.set(fingerprint, occurrence + 1);
    if (occurrence < (existingLegacyOccurrences.get(fingerprint) ?? 0)) return false;
    return true;
  });
  const base = updated ?? currentEvents;
  return uniqueNewEvents.length > 0 ? [...base, ...uniqueNewEvents] : base;
};

export type IncrementalTaskLiveUpdatePayload = Pick<TaskLiveUpdatePayload, 'taskId'>
  & Partial<Omit<TaskLiveUpdatePayload, 'taskId'>>;

const hasUpdateField = (
  payload: IncrementalTaskLiveUpdatePayload,
  field: keyof TaskLiveUpdatePayload
): boolean =>
  Object.prototype.hasOwnProperty.call(payload, field);

export const mergeIncrementalLiveDetails = (
  previous: LiveDetails,
  payload: IncrementalTaskLiveUpdatePayload,
  isLive = true
): LiveDetails => {
  const newEvents: LiveEvent[] = payload.events || [];
  const events = appendUniqueEvents(previous.events, newEvents);
  const capped = isLive ? capLiveEvents(events) : { events, dropped: 0 };
  const omitted = previous.omittedEventCount !== undefined || capped.dropped > 0
    ? { omittedEventCount: (previous.omittedEventCount ?? 0) + capped.dropped }
    : {};
  return {
    events: capped.events,
    ...omitted,
    ...(previous.historyTruncated ? { historyTruncated: true } : {}),
    todos: hasUpdateField(payload, 'todos') ? normalizeLiveTodos(payload.todos ?? []) : previous.todos,
    currentTask: hasUpdateField(payload, 'currentTask') ? payload.currentTask ?? null : previous.currentTask,
    tokenUsage: hasUpdateField(payload, 'tokenUsage') ? payload.tokenUsage ?? null : previous.tokenUsage,
    ...(payload.liveOutputPosition ? { liveOutputPosition: payload.liveOutputPosition } : {}),
  };
};

/**
 * A socket payload carrying `omittedEventCount` is full state (initial, or after a resync); others are increments.
 * Covered updates can restore missing history, but cannot replace newer event versions or metadata.
 * A full read can finish before the watcher broadcasts an older snapshot.
 */
export const applyTaskLiveUpdate = (previous: LiveDetails, payload: IncrementalTaskLiveUpdatePayload, isLive = true): LiveDetails => {
  if (readCoversUpdate(previous, payload)) {
    if (previous.liveOutputPosition?.epoch !== payload.liveOutputPosition?.epoch) return previous;
    // A later offset proves freshness, not inclusion: retention may have removed
    // readable history delivered while this read was in flight. The read wins
    // shared event versions and every metadata field.
    return mergeFullLiveDetails({ ...previous, events: payload.events || [] }, previous, isLive);
  }
  if (payload.omittedEventCount === undefined) return mergeIncrementalLiveDetails(previous, payload, isLive);
  return mergeFullLiveDetails(previous, {
    events: payload.events || [],
    todos: normalizeLiveTodos(payload.todos || []),
    currentTask: payload.currentTask || null,
    tokenUsage: payload.tokenUsage || null,
    omittedEventCount: payload.omittedEventCount,
    historyTruncated: payload.historyTruncated,
    liveOutputPosition: payload.liveOutputPosition,
  }, isLive);
};

export const useTaskData = (taskId: string | undefined) => {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [taskInfo, setTaskInfo] = useState<TaskInfo | null>(null);
  const [usageMetricRecords, setUsageMetricRecords] = useState<UsageMetricRecord[]>([]);
  const [previewMedia, setPreviewMedia] = useState<PublishedVisualPreview[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [liveDetails, setLiveDetails] = useState<LiveDetails>({ events: [], todos: [], currentTask: null });
  const [stoppingExecution, setStoppingExecution] = useState<boolean>(false);
  const [stopFailed, setStopFailed] = useState<boolean>(false);
  const [deletingTask, setDeletingTask] = useState<boolean>(false);
  const { addToast } = useToast();
  const currentUser = useCurrentUser();
  const { subscribeToTask, unsubscribeFromTask, onTaskUpdate, isConnected, subscribeToTaskLive, unsubscribeFromTaskLive, onTaskLiveUpdate } = useSocket();
  // Track the last notified terminal state to avoid duplicate toasts
  const lastNotifiedStateRef = useRef<string | null>(null);
  const hasReceivedSocketStateRef = useRef<boolean>(false);
  const socketRevisionRef = useRef(0);
  const liveReadSequence = useRef(0);
  const finishedLiveReadScope = useRef<string | null>(null);
  const pendingLiveRead = useRef<TaskLiveUpdatePayload[] | null>(null);
  // Executions a read proved were replaced; the watcher can still deliver their updates late.
  const supersededExecutionsRef = useRef(new Set<string>());
  // Track if we've received initial data from WebSocket (to distinguish initial vs incremental updates)
  // A route parameter can change without unmounting this hook. Late responses
  // from the previous task must never replace the newly selected task's data.
  const activeTaskIdRef = useRef(taskId);
  activeTaskIdRef.current = taskId;
  const requestScopeKey = `${getDesktopSocketConfigurationKey()}\0${currentUser?.id ?? ''}\0${taskId ?? ''}`;
  const activeRequestScopeRef = useRef(requestScopeKey);
  activeRequestScopeRef.current = requestScopeKey;
  const latestHistoryRef = useRef(history);
  latestHistoryRef.current = history;

  // Fetch task history data
  const fetchTaskHistory = useCallback(async () => {
    if (!taskId) return;
    const requestedScope = requestScopeKey;

    try {
      const data = await getTaskHistory(taskId) as TaskHistoryData;
      if (activeRequestScopeRef.current !== requestedScope) return data;
      const nextHistory = data.history || [];
      latestHistoryRef.current = nextHistory;
      setHistory(nextHistory);
      setTaskInfo(data.taskInfo || null);
      setUsageMetricRecords(data.usageMetricRecords || []);
      // Only trusted GitHub attachment URLs may become media sources.
      setPreviewMedia(trustedPreviewMedia(data.previewMedia || data.taskInfo?.previewMedia, 8));
      return data;
    } catch (err) {
      console.error('Error fetching task history:', err);
      throw err;
    }
  }, [requestScopeKey, taskId]);

  const fetchPersistedLiveDetails = useCallback(async () => {
    if (!taskId) return null;
    const requestedScope = requestScopeKey;
    const socketRevision = socketRevisionRef.current;
    const finishedAtRequest = isFinishedTask(latestHistoryRef.current.at(-1)?.state);
    const sequence = ++liveReadSequence.current;
    const updates: TaskLiveUpdatePayload[] = [];
    pendingLiveRead.current = updates;
    // State updates apply in order, so this captures exactly the state the buffer
    // starts from: every update applied before the read and none buffered during it.
    const atRequest: { state?: LiveDetails } = {};
    setLiveDetails(previous => { atRequest.state = previous; return previous; });

    try {
      const data = await getTaskLiveDetails(taskId) as LiveDetails;
      if (activeRequestScopeRef.current !== requestedScope || sequence !== liveReadSequence.current) return data;
      // The socket subscription runs in parallel with this read, and its first
      // payload is already full state. Never let an older HTTP snapshot replace
      // newer socket state that arrived while the request was pending.
      const isLive = !isFinishedTask(latestHistoryRef.current.at(-1)?.state);
      if (!isLive || (!hasReceivedSocketStateRef.current && socketRevision === socketRevisionRef.current)) {
        finishedLiveReadScope.current = finishedAtRequest ? requestedScope : null;
        // Replay updates over the pre-request state, which has not applied them yet,
        // except those the response already contains (possibly in a newer version)
        // and those of executions earlier than the response's, including one first
        // received during the read.
        setLiveDetails(previous => {
          if (activeRequestScopeRef.current !== requestedScope || sequence !== liveReadSequence.current) return previous;
          const superseded = executionSupersededByRead(atRequest.state ?? previous, data);
          if (superseded) supersededExecutionsRef.current.add(superseded);
          return updates.filter(update => !isSupersededUpdate(supersededExecutionsRef.current, update))
            .reduce((state, update) => applyTaskLiveUpdate(state, update, isLive),
              mergeFullLiveDetails(atRequest.state ?? previous, data, isLive));
        });
      }
      return data;
    } catch (err) {
      console.error('Error fetching persisted live details:', err);
      return null;
    } finally {
      if (pendingLiveRead.current === updates) pendingLiveRead.current = null;
    }
  }, [requestScopeKey, taskId]);

  const scheduleTaskHistoryRefresh = useLiveRefreshScheduler({
    isConnected,
    refresh: fetchTaskHistory,
    scopeKey: requestScopeKey,
  });

  useEffect(() => {
    lastNotifiedStateRef.current = null;
    hasReceivedSocketStateRef.current = false;
    supersededExecutionsRef.current = new Set();
  }, [requestScopeKey]);

  // Handle task update from WebSocket
  const handleTaskUpdate = useCallback((payload: TaskUpdatePayload) => {
    if (payload.taskId !== activeTaskIdRef.current) return;

    console.log('[useTaskData] Received task update via WebSocket:', payload);

    // A task can emit several state/progress notifications close together.
    // Coalesce those invalidations and serialize a trailing read when a newer
    // update arrives while the current request is pending.
    scheduleTaskHistoryRefresh();

    // Check for terminal states and show toast notifications
    const state = payload.state?.toUpperCase() || '';
    if (state === 'COMPLETED' && lastNotifiedStateRef.current !== 'COMPLETED') {
      lastNotifiedStateRef.current = 'COMPLETED';
      addToast({ type: 'success', message: 'Task completed successfully' });
    } else if (state === 'FAILED' && lastNotifiedStateRef.current !== 'FAILED') {
      lastNotifiedStateRef.current = 'FAILED';
      addToast({ type: 'error', message: 'Task execution failed' });
    }
  }, [scheduleTaskHistoryRefresh, addToast]);

  // Handle task live update from WebSocket
  // This updates the terminal output directly from WebSocket data - no HTTP calls needed
  // WebSocket sends full state on initial subscription, then only new events on updates
  const handleTaskLiveUpdate = useCallback((payload: TaskLiveUpdatePayload) => {
    if (payload.taskId !== activeTaskIdRef.current) return;
    if (isSupersededUpdate(supersededExecutionsRef.current, payload)) return;

    hasReceivedSocketStateRef.current = true;
    socketRevisionRef.current += 1;
    pendingLiveRead.current?.push(payload);
    setLiveDetails(previous => applyTaskLiveUpdate(previous, payload, !isFinishedTask(latestHistoryRef.current.at(-1)?.state)));
  }, []);

  // Initial data fetch
  useEffect(() => {
    let active = true;
    const fetchInitialData = async () => {
      if (!taskId) return;

      try {
        setLoading(true);
        setError(null);
        // Initial reads are immediate, but use the same coordinator as socket
        // invalidations so an update during this request becomes one trailing
        // authoritative read instead of an overlapping request.
        await scheduleTaskHistoryRefresh.refreshNow();
        if (!active) return;
        await fetchPersistedLiveDetails();
      } catch (err) {
        if (!active) return;
        setError((err as Error).message);
        console.error('Error fetching task history:', err);
      } finally {
        if (active) setLoading(false);
      }
    };

    void fetchInitialData();
    return () => { active = false; };
  }, [taskId, scheduleTaskHistoryRefresh, fetchPersistedLiveDetails]);

  const finished = isFinishedTask(history.at(-1)?.state);
  useEffect(() => {
    // Live payloads only included the retained window. Fetch full history on completion.
    if (!finished) finishedLiveReadScope.current = null;
    else if (!loading && finishedLiveReadScope.current !== requestScopeKey) void fetchPersistedLiveDetails();
  }, [finished, loading, requestScopeKey, fetchPersistedLiveDetails]);

  // Subscribe to WebSocket events for this task
  useEffect(() => {
    if (!taskId || !isConnected) return;

    // Subscribe to this specific task's room for state updates
    subscribeToTask(taskId);

    // Subscribe to live task updates (Claude log streaming)
    subscribeToTaskLive(taskId);

    // Listen for task updates
    const unsubscribeTask = onTaskUpdate(handleTaskUpdate);

    // Listen for live task updates (terminal output)
    const unsubscribeLive = onTaskLiveUpdate(handleTaskLiveUpdate);

    return () => {
      unsubscribeFromTask(taskId);
      unsubscribeFromTaskLive(taskId);
      unsubscribeTask();
      unsubscribeLive();
      // Reset initial data flag on cleanup so re-subscription gets fresh state
      hasReceivedSocketStateRef.current = false;
    };
  }, [requestScopeKey, taskId, isConnected, subscribeToTask, unsubscribeFromTask, subscribeToTaskLive, unsubscribeFromTaskLive, onTaskUpdate, onTaskLiveUpdate, handleTaskUpdate, handleTaskLiveUpdate]);

  // Live details are now delivered entirely via WebSocket
  // Initial data is sent when subscribing to task:live, then only new events on updates
  // No HTTP fallback needed

  const handleStopExecution = async () => {
    if (!taskId) return;

    const confirmed = window.confirm('Are you sure you want to stop this execution? This action cannot be undone.');
    if (!confirmed) return;

    try {
      setStoppingExecution(true);
      const result: StopExecutionResponse = await stopTaskExecution(taskId);

      // Immediately refresh task history to show the new state
      await scheduleTaskHistoryRefresh.refreshNow();

      // If container was stopped successfully, clear stopping state immediately
      // Otherwise, poll a couple more times to wait for state to update
      if (result.containerStopped) {
        setStoppingExecution(false);
      } else {
        // Container might still be stopping, poll for updates
        let pollCount = 0;
        const pollInterval = setInterval(async () => {
          pollCount++;
          await scheduleTaskHistoryRefresh.refreshNow();

          // Check if task is now in a terminal state
          const latestHistory = latestHistoryRef.current;
          const latestState = latestHistory[latestHistory.length - 1]?.state?.toUpperCase();
          const isTerminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(latestState || '');

          if (isTerminal || pollCount >= 5) {
            clearInterval(pollInterval);
            setStoppingExecution(false);
          }
        }, 1500);
      }
    } catch (err) {
      console.error('Error stopping execution:', err);
      alert(`Failed to stop execution: ${(err as Error).message || 'Unknown error'}. The task may have already stopped. You can now delete it.`);
      setStoppingExecution(false);
      setStopFailed(true);
    }
  };

  const handleDeleteTask = async (): Promise<boolean> => {
    if (!taskId) return false;

    const confirmed = window.confirm('Are you sure you want to delete this task? This action cannot be undone.');
    if (!confirmed) return false;

    try {
      setDeletingTask(true);
      // Use force=true if stop operation previously failed (task may be stuck but not running)
      await deleteTask(taskId, stopFailed);
      return true; // Indicates successful deletion
    } catch (err) {
      console.error('Error deleting task:', err);
      alert(`Failed to delete task: ${(err as Error).message || 'Unknown error'}`);
      return false;
    } finally {
      setDeletingTask(false);
    }
  };

  return {
    history,
    taskInfo,
    usageMetricRecords,
    previewMedia,
    loading,
    error,
    liveDetails,
    stoppingExecution,
    stopFailed,
    handleStopExecution,
    deletingTask,
    handleDeleteTask
  };
};

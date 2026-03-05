import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getTaskHistory,
  getTaskLiveDetails,
  getTaskAnalysis,
  stopTaskExecution,
  StopExecutionResponse,
  deleteTask
} from '../../api/proprApi';
import {
  HistoryItem,
  TaskInfo,
  LiveDetails,
  AnalysisData
} from './types';
import { useToast } from '../ui/useToast';
import { useSocket } from '../../contexts/useSocket';
import { TaskUpdatePayload, TaskLiveUpdatePayload } from '@propr/shared';

export const useTaskData = (taskId: string | undefined) => {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [taskInfo, setTaskInfo] = useState<TaskInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [liveDetails, setLiveDetails] = useState<LiveDetails>({ events: [], todos: [], currentTask: null });
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState<boolean>(true);
  const [stoppingExecution, setStoppingExecution] = useState<boolean>(false);
  const [stopFailed, setStopFailed] = useState<boolean>(false);
  const [deletingTask, setDeletingTask] = useState<boolean>(false);
  const { addToast } = useToast();
  const { subscribeToTask, unsubscribeFromTask, onTaskUpdate, isConnected, subscribeToTaskLive, unsubscribeFromTaskLive, onTaskLiveUpdate } = useSocket();
  // Track the last notified terminal state to avoid duplicate toasts
  const lastNotifiedStateRef = useRef<string | null>(null);

  // Debounce timer for live details refetch
  const liveDetailsDebounceRef = useRef<NodeJS.Timeout | null>(null);
  // Track pending live update to batch multiple WebSocket events
  const pendingLiveUpdateRef = useRef<TaskLiveUpdatePayload | null>(null);

  // Fetch task history data
  const fetchTaskHistory = useCallback(async () => {
    if (!taskId) return;

    try {
      const data = await getTaskHistory(taskId);
      setHistory(data.history || []);
      setTaskInfo(data.taskInfo || null);
      return data;
    } catch (err) {
      console.error('Error fetching task history:', err);
      throw err;
    }
  }, [taskId]);

  // Fetch live details data
  const fetchLiveDetails = useCallback(async () => {
    if (!taskId) return;

    try {
      const data = await getTaskLiveDetails(taskId);
      setLiveDetails(data);
    } catch (err) {
      console.error('Error fetching live task details:', err);
    }
  }, [taskId]);

  // Handle task update from WebSocket
  const handleTaskUpdate = useCallback(async (payload: TaskUpdatePayload) => {
    if (payload.taskId !== taskId) return;

    console.log('[useTaskData] Received task update via WebSocket:', payload);

    // Refresh task history when we receive an update
    await fetchTaskHistory();

    // Check for terminal states and show toast notifications
    const state = payload.state?.toUpperCase() || '';
    if (state === 'COMPLETED' && lastNotifiedStateRef.current !== 'COMPLETED') {
      lastNotifiedStateRef.current = 'COMPLETED';
      addToast({
        type: 'success',
        message: 'Task completed successfully',
      });
    } else if (state === 'FAILED' && lastNotifiedStateRef.current !== 'FAILED') {
      lastNotifiedStateRef.current = 'FAILED';
      addToast({
        type: 'error',
        message: 'Task execution failed',
      });
    }
  }, [taskId, fetchTaskHistory, addToast]);

  // Handle task live update from WebSocket with debouncing
  // This updates the terminal output directly from WebSocket data to stay fluid
  const handleTaskLiveUpdate = useCallback((payload: TaskLiveUpdatePayload) => {
    if (payload.taskId !== taskId) return;

    console.log('[useTaskData] Received task live update via WebSocket:', payload);

    // Directly update live details from the WebSocket payload for immediate UI update
    // This avoids HTTP calls and keeps the terminal output fluid
    setLiveDetails({
      events: payload.events || [],
      todos: payload.todos || [],
      currentTask: payload.currentTask || null,
    });

    // Store the latest update for potential batched HTTP refetch if needed
    pendingLiveUpdateRef.current = payload;

    // Debounce HTTP refetch to avoid overwhelming the API
    // Only refetch if we haven't received another update within the debounce window
    if (liveDetailsDebounceRef.current) {
      clearTimeout(liveDetailsDebounceRef.current);
    }

    // Debounce for 1 second - if no new updates come in, do a full HTTP refetch
    // to ensure we have complete data (WebSocket might have partial updates)
    liveDetailsDebounceRef.current = setTimeout(async () => {
      // Only refetch if the pending update is still the same (no new updates came in)
      if (pendingLiveUpdateRef.current === payload) {
        console.log('[useTaskData] Debounced HTTP refetch for live details');
        await fetchLiveDetails();
        pendingLiveUpdateRef.current = null;
      }
    }, 1000);
  }, [taskId, fetchLiveDetails]);

  // Initial data fetch
  useEffect(() => {
    const fetchInitialData = async () => {
      if (!taskId) return;

      try {
        setLoading(true);
        await fetchTaskHistory();
      } catch (err) {
        setError((err as Error).message);
        console.error('Error fetching task history:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchInitialData();
  }, [taskId, fetchTaskHistory]);

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

      // Clean up debounce timer
      if (liveDetailsDebounceRef.current) {
        clearTimeout(liveDetailsDebounceRef.current);
        liveDetailsDebounceRef.current = null;
      }
      pendingLiveUpdateRef.current = null;
    };
  }, [taskId, isConnected, subscribeToTask, unsubscribeFromTask, subscribeToTaskLive, unsubscribeFromTaskLive, onTaskUpdate, onTaskLiveUpdate, handleTaskUpdate, handleTaskLiveUpdate]);

  // Fetch analysis data (separate from task updates, typically only needed once)
  useEffect(() => {
    const fetchAnalysis = async () => {
      if (!taskId) return;

      try {
        setAnalysisLoading(true);
        const analysisData = await getTaskAnalysis(taskId);
        setAnalysis(analysisData.analysis);
      } catch (err) {
        console.error('Error fetching analysis:', err);
      } finally {
        setAnalysisLoading(false);
      }
    };

    fetchAnalysis();
  }, [taskId]);

  // Fetch live details initially and when history changes
  useEffect(() => {
    if (!taskId || history.length === 0) return;

    fetchLiveDetails();
  }, [taskId, history.length, fetchLiveDetails]);

  const handleStopExecution = async () => {
    if (!taskId) return;

    const confirmed = window.confirm('Are you sure you want to stop this execution? This action cannot be undone.');
    if (!confirmed) return;

    try {
      setStoppingExecution(true);
      const result: StopExecutionResponse = await stopTaskExecution(taskId);

      // Immediately refresh task history to show the new state
      await fetchTaskHistory();

      // If container was stopped successfully, clear stopping state immediately
      // Otherwise, poll a couple more times to wait for state to update
      if (result.containerStopped) {
        setStoppingExecution(false);
      } else {
        // Container might still be stopping, poll for updates
        let pollCount = 0;
        const pollInterval = setInterval(async () => {
          pollCount++;
          const updatedData = await fetchTaskHistory();

          // Check if task is now in a terminal state
          const latestState = updatedData?.history?.[updatedData.history.length - 1]?.state?.toUpperCase();
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
    loading,
    error,
    liveDetails,
    analysis,
    analysisLoading,
    stoppingExecution,
    stopFailed,
    handleStopExecution,
    deletingTask,
    handleDeleteTask
  };
};

import { useCallback, useEffect, useRef, useState } from 'react';
import { getTaskLiveDetails } from '../../api/proprApi';
import { useSocket } from '../../contexts/useSocket';
import type { TaskLiveUpdatePayload } from '@propr/shared';
import type { LiveDetails, LiveEvent } from './types';
import { mergeIncrementalLiveDetails, normalizeLiveTodos } from './useTaskData';

export function useTaskLiveData(taskId: string | undefined, pollIntervalMs = 5_000) {
  const [liveDetails, setLiveDetails] = useState<LiveDetails>({ events: [], todos: [], currentTask: null });
  const hasReceivedInitialDataRef = useRef(false);
  const {
    subscribeToTaskLive,
    unsubscribeFromTaskLive,
    onTaskLiveUpdate,
    isConnected,
  } = useSocket();

  const refresh = useCallback(async () => {
    if (!taskId) return null;
    try {
      const data = await getTaskLiveDetails(taskId) as LiveDetails;
      setLiveDetails({
        events: data.events || [],
        todos: data.todos || [],
        currentTask: data.currentTask || null,
        tokenUsage: data.tokenUsage || null,
      });
      return data;
    } catch {
      return null;
    }
  }, [taskId]);

  useEffect(() => {
    void refresh();
    if (!taskId || pollIntervalMs <= 0) return;
    const timer = window.setInterval(() => { void refresh(); }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [pollIntervalMs, refresh, taskId]);

  useEffect(() => {
    if (!taskId || !isConnected) return;
    subscribeToTaskLive(taskId);
    const unsubscribe = onTaskLiveUpdate((payload: TaskLiveUpdatePayload) => {
      if (payload.taskId !== taskId) return;
      const newEvents: LiveEvent[] = payload.events || [];
      if (!hasReceivedInitialDataRef.current) {
        hasReceivedInitialDataRef.current = true;
        setLiveDetails({
          events: newEvents,
          todos: normalizeLiveTodos(payload.todos || []),
          currentTask: payload.currentTask || null,
          tokenUsage: payload.tokenUsage || null,
        });
      } else {
        setLiveDetails(previous => mergeIncrementalLiveDetails(previous, payload));
      }
    });
    return () => {
      unsubscribe();
      unsubscribeFromTaskLive(taskId);
      hasReceivedInitialDataRef.current = false;
    };
  }, [isConnected, onTaskLiveUpdate, subscribeToTaskLive, taskId, unsubscribeFromTaskLive]);

  return { liveDetails, refreshLiveDetails: refresh };
}

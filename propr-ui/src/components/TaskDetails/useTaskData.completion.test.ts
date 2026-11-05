import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LiveDetails, LiveEvent } from './types';
import { useTaskData } from './useTaskData';

const apiMocks = vi.hoisted(() => ({
  getTaskHistory: vi.fn(),
  getTaskLiveDetails: vi.fn(),
  stopTaskExecution: vi.fn(),
  deleteTask: vi.fn(),
}));

const socketMocks = vi.hoisted(() => {
  const value = {
    isConnected: true,
    taskUpdateHandler: null as ((payload: { taskId: string; state?: string }) => void) | null,
    liveUpdateHandler: null as ((payload: unknown) => void) | null,
    subscribeToTask: vi.fn(),
    unsubscribeFromTask: vi.fn(),
    subscribeToTaskLive: vi.fn(),
    unsubscribeFromTaskLive: vi.fn(),
    onTaskUpdate: (handler: ((payload: { taskId: string; state?: string }) => void) | null) => {
      value.taskUpdateHandler = handler;
      return () => { if (value.taskUpdateHandler === handler) value.taskUpdateHandler = null; };
    },
    onTaskLiveUpdate: (handler: ((payload: unknown) => void) | null) => {
      value.liveUpdateHandler = handler;
      return () => { if (value.liveUpdateHandler === handler) value.liveUpdateHandler = null; };
    },
  };
  return value;
});

vi.mock('../../api/proprApi', () => apiMocks);
vi.mock('../ui/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('../../contexts/useSocket', () => ({ useSocket: () => socketMocks }));

afterEach(() => { cleanup(); vi.useRealTimers(); });

const liveThought = (index: number): LiveEvent => ({ id: `live:task:redis:legacy:${index}:0`, type: 'thought', content: `Narration ${index}` });
const canonical: LiveDetails = {
  events: [
    { id: 'live:task:database:session-2:0', type: 'thought', content: 'Narration 0' },
    { id: 'live:task:database:session-2:1', type: 'tool_use', toolName: 'Bash' },
    { id: 'live:task:database:session-2:2', type: 'tool_result' },
  ],
  todos: [],
  currentTask: null,
  omittedEventCount: 0,
};

// The watcher stops broadcasting once a finished task serves persisted details,
// so a subscribed client relies on its completion read for the canonical trace.
it('replaces the live view of a subscribed client with persisted details when the task completes', async () => {
  vi.useFakeTimers();
  apiMocks.getTaskHistory.mockResolvedValue({ history: [{ state: 'CLAUDE_EXECUTION' }], taskInfo: null });
  apiMocks.getTaskLiveDetails.mockResolvedValue({ events: [], todos: [], currentTask: null });
  const { result } = renderHook(() => useTaskData('task'));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [liveThought(0)], todos: [], currentTask: null, omittedEventCount: 0 }));
  expect(result.current.liveDetails.events).toEqual([liveThought(0)]);

  // Final output and completion arrive between polls: no further live broadcast.
  apiMocks.getTaskHistory.mockResolvedValue({ history: [{ state: 'CLAUDE_EXECUTION' }, { state: 'COMPLETED' }], taskInfo: null });
  apiMocks.getTaskLiveDetails.mockResolvedValue(canonical);
  act(() => socketMocks.taskUpdateHandler?.({ taskId: 'task', state: 'COMPLETED' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });

  expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(2);
  expect(result.current.liveDetails.events).toEqual(canonical.events);
  expect(result.current.liveDetails.omittedEventCount).toBe(0);
});

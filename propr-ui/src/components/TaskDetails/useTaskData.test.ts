import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveDetails } from './types';
import {
  mergeIncrementalLiveDetails,
  normalizeLiveTodos,
  useTaskData,
  type IncrementalTaskLiveUpdatePayload,
} from './useTaskData';

const apiMocks = vi.hoisted(() => ({
  getTaskHistory: vi.fn(),
  getTaskAnalysis: vi.fn(),
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
      return () => {
        if (value.taskUpdateHandler === handler) value.taskUpdateHandler = null;
      };
    },
    onTaskLiveUpdate: (handler: ((payload: unknown) => void) | null) => {
      value.liveUpdateHandler = handler;
      return () => {
        if (value.liveUpdateHandler === handler) value.liveUpdateHandler = null;
      };
    },
  };
  return value;
});

const toastMocks = vi.hoisted(() => ({ addToast: vi.fn() }));

vi.mock('../../api/proprApi', () => apiMocks);
vi.mock('../ui/useToast', () => ({ useToast: () => toastMocks }));
vi.mock('../../contexts/useSocket', () => ({
  useSocket: () => socketMocks,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const previous: LiveDetails = {
  events: [{ type: 'thought', content: 'Existing event' }],
  todos: [{ id: 'todo-1', content: 'Keep this', status: 'in_progress' }],
  currentTask: 'Keep current task',
  tokenUsage: { input_tokens: 10, output_tokens: 4 },
};

describe('incremental task live updates', () => {
  it('preserves state fields omitted from an incremental event update', () => {
    const payload: IncrementalTaskLiveUpdatePayload = {
      taskId: 'task-1',
      events: [{ type: 'thought', content: 'New event', timestamp: '2026-08-03T00:00:00.000Z' }],
    };

    expect(mergeIncrementalLiveDetails(previous, payload)).toEqual({
      ...previous,
      events: [
        { type: 'thought', content: 'Existing event' },
        { type: 'thought', content: 'New event', timestamp: '2026-08-03T00:00:00.000Z' },
      ],
    });
  });

  it('applies explicit empty and null fields', () => {
    const payload: IncrementalTaskLiveUpdatePayload = {
      taskId: 'task-1',
      events: [],
      todos: [],
      currentTask: null,
      tokenUsage: null,
    };

    expect(mergeIncrementalLiveDetails(previous, payload)).toEqual({
      events: previous.events,
      todos: [],
      currentTask: null,
      tokenUsage: null,
    });
  });

  it('keeps distinct events that have stable IDs despite identical legacy content', () => {
    const payload: IncrementalTaskLiveUpdatePayload = {
      taskId: 'task-1',
      events: [
        { id: 'event-1', type: 'thought', content: 'Same output', timestamp: '2026-08-03T00:00:00.000Z' },
        { id: 'event-2', type: 'thought', content: 'Same output', timestamp: '2026-08-03T00:00:00.000Z' },
      ],
    };

    expect(mergeIncrementalLiveDetails({ ...previous, events: [] }, payload).events).toHaveLength(2);
  });

  it('uses timestamp and occurrence index to preserve repeated legacy output while deduplicating resends', () => {
    const firstEvent = {
      type: 'thought' as const,
      content: 'Repeated output',
      timestamp: '2026-08-03T00:00:00.000Z',
    };
    const payload: IncrementalTaskLiveUpdatePayload = {
      taskId: 'task-1',
      events: [
        firstEvent,
        { ...firstEvent },
        { ...firstEvent, timestamp: '2026-08-03T00:00:01.000Z' },
      ],
    };

    const firstMerge = mergeIncrementalLiveDetails({ ...previous, events: [] }, payload);
    expect(firstMerge.events).toEqual(payload.events);
    expect(mergeIncrementalLiveDetails(firstMerge, payload).events).toEqual(payload.events);
  });

  it('uses tool-use IDs without dropping the matching tool result', () => {
    const payload: IncrementalTaskLiveUpdatePayload = {
      taskId: 'task-1',
      events: [
        { type: 'tool_use', toolName: 'Read', toolUseId: 'call-1', input: { file_path: 'README.md' }, timestamp: '2026-08-03T00:00:00.000Z' },
        { type: 'tool_use', toolName: 'Read', toolUseId: 'call-2', input: { file_path: 'README.md' }, timestamp: '2026-08-03T00:00:00.000Z' },
        { type: 'tool_result', toolUseId: 'call-1', result: 'contents', timestamp: '2026-08-03T00:00:00.000Z' },
      ],
    };

    expect(mergeIncrementalLiveDetails({ ...previous, events: [] }, payload).events).toEqual(payload.events);
  });

  it('keeps todo IDs stable when distinct items are reordered', () => {
    const todos = [
      { content: 'Inspect the parser', status: 'pending' },
      { content: 'Run the tests', status: 'in_progress' },
    ];
    const original = normalizeLiveTodos(todos);
    const reordered = normalizeLiveTodos([...todos].reverse());

    expect(Object.fromEntries(original.map(todo => [todo.content, todo.id]))).toEqual(
      Object.fromEntries(reordered.map(todo => [todo.content, todo.id]))
    );
  });

  it('preserves IDs supplied by the server', () => {
    expect(normalizeLiveTodos([
      { id: 'server-todo-42', content: 'Keep this row', status: 'completed' },
    ])[0].id).toBe('server-todo-42');
  });
});

describe('task detail history refreshes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    socketMocks.taskUpdateHandler = null;
    socketMocks.liveUpdateHandler = null;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    apiMocks.getTaskHistory.mockResolvedValue({ history: [], taskInfo: null, usageMetricRecords: [] });
    apiMocks.getTaskLiveDetails.mockResolvedValue({ events: [], todos: [], currentTask: null });
    apiMocks.getTaskAnalysis.mockResolvedValue({ analysis: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns the fixture baseline of three burst invalidations into one additional history request', async () => {
    renderHook(() => useTaskData('task-1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(apiMocks.getTaskHistory).toHaveBeenCalledTimes(1);

    act(() => {
      socketMocks.taskUpdateHandler?.({ taskId: 'task-1', state: 'processing' });
      socketMocks.taskUpdateHandler?.({ taskId: 'task-1', state: 'processing' });
      socketMocks.taskUpdateHandler?.({ taskId: 'task-1', state: 'processing' });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    // Fixture count: 1 initial + 1 coalesced live read (previously 1 + 3).
    expect(apiMocks.getTaskHistory).toHaveBeenCalledTimes(2);
  });

  it('keeps data from a late old-task response out of the newly selected task', async () => {
    const taskA = deferred<{ history: Array<{ state: string }>; taskInfo: null; usageMetricRecords: never[] }>();
    apiMocks.getTaskHistory.mockImplementation((taskId: string) => taskId === 'task-a'
      ? taskA.promise
      : Promise.resolve({ history: [{ state: 'TASK_B' }], taskInfo: null, usageMetricRecords: [] }));
    let taskId = 'task-a';
    const { result, rerender } = renderHook(() => useTaskData(taskId));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    taskId = 'task-b';
    rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.history).toEqual([{ state: 'TASK_B' }]);

    await act(async () => {
      taskA.resolve({ history: [{ state: 'TASK_A' }], taskInfo: null, usageMetricRecords: [] });
      await taskA.promise;
    });
    expect(result.current.history).toEqual([{ state: 'TASK_B' }]);
  });

  it('does not replace newer socket logs with a persisted snapshot that finishes later', async () => {
    const persisted = deferred<LiveDetails>();
    apiMocks.getTaskLiveDetails.mockReturnValue(persisted.promise);
    const { result } = renderHook(() => useTaskData('task-1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    act(() => {
      socketMocks.liveUpdateHandler?.({
        taskId: 'task-1',
        events: [{ id: 'new-event', type: 'thought', content: 'new socket log' }],
        todos: [],
        currentTask: 'new state',
      });
    });
    await act(async () => {
      persisted.resolve({
        events: [{ id: 'old-event', type: 'thought', content: 'old persisted log' }],
        todos: [],
        currentTask: 'old state',
      });
      await persisted.promise;
    });

    expect(result.current.liveDetails.events).toEqual([
      { id: 'new-event', type: 'thought', content: 'new socket log' },
    ]);
    expect(result.current.liveDetails.currentTask).toBe('new state');
  });
});

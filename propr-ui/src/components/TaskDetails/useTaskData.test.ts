import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveDetails } from './types';
import { useTaskLiveData } from './useTaskLiveData';
import { mergeIncrementalLiveDetails, normalizeLiveTodos, useTaskData, type IncrementalTaskLiveUpdatePayload, applyTaskLiveUpdate, capLiveEvents, mergeFullLiveDetails } from './useTaskData';

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

it('does not let disconnect cleanup authorize an HTTP read older than socket content', async () => {
  vi.clearAllMocks();
  socketMocks.isConnected = true;
  apiMocks.getTaskHistory.mockResolvedValue({ history: [], taskInfo: null });
  const persisted = deferred<LiveDetails>();
  apiMocks.getTaskLiveDetails.mockReturnValue(persisted.promise);
  const { result, rerender, unmount } = renderHook(() => useTaskData('task'));
  await act(async () => {});
  act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [{ id: 'a', type: 'thought', content: 'Checking the parser' }] }));
  socketMocks.isConnected = false;
  rerender();
  await act(async () => {
    persisted.resolve({ events: [{ id: 'a', type: 'thought', content: 'Checking' }], todos: [], currentTask: null });
    await persisted.promise;
  });
  expect(result.current.liveDetails.events[0].content).toBe('Checking the parser');
  unmount();
  socketMocks.isConnected = true;
});

describe('long live logs', () => {
  const thought = (id: string, content = id) => ({ id, type: 'thought', content });
  const tool = (id: string) => ({ id, type: 'tool_use', toolName: 'Bash' });

  it('keeps every readable event and only the most recent raw events', () => {
    const events = Array.from({ length: 700 }, (_, index) => (index % 7 === 0 ? thought(`t${index}`) : tool(`r${index}`)));
    const capped = capLiveEvents(events as never, 500);
    expect(capped.events.filter(event => event.type === 'thought')).toHaveLength(100);
    expect(capped.events.filter(event => event.type !== 'thought')).toHaveLength(500);
    expect(capped.dropped).toBe(100);
    expect(capped.events.at(-1)?.id).toBe('r699');
  });

  it('replaces an event whose content grew under the same ID instead of duplicating it', () => {
    const previous = { events: [thought('a', 'Checking')], todos: [], currentTask: null };
    const merged = mergeIncrementalLiveDetails(previous as never, { taskId: 'task-1', events: [thought('a', 'Checking the parser'), tool('b')] } as never);
    expect(merged.events.map(event => [event.id, event.content])).toEqual([['a', 'Checking the parser'], ['b', undefined]]);
  });

  it('lets a full-state read set the order while keeping newer socket events after it', () => {
    const previous = { events: [thought('a'), tool('b'), tool('c')], todos: [], currentTask: null };
    const merged = mergeFullLiveDetails(previous as never, { events: [thought('earlier'), thought('a'), tool('b')], todos: [], currentTask: null, omittedEventCount: 3 } as never);
    expect(merged.events.map(event => event.id)).toEqual(['earlier', 'a', 'b', 'c']);
    expect(merged.omittedEventCount).toBe(3);
  });

  it('treats a socket payload with omittedEventCount as full state and others as increments', () => {
    const previous = { events: [thought('a')], todos: [], currentTask: null };
    const increment = applyTaskLiveUpdate(previous as never, { taskId: 'task-1', events: [tool('b')] } as never);
    expect(increment.events.map(event => event.id)).toEqual(['a', 'b']);
    const nextExecution = applyTaskLiveUpdate(increment, { taskId: 'task-1', events: [thought('x')], todos: [], currentTask: null, tokenUsage: null, omittedEventCount: 0 } as never);
    expect(nextExecution.events.map(event => event.id)).toEqual(['x']);
  });
});


describe('full live history retention', () => {
  const event = (epoch: number, index: number) => ({ id: `live:task:redis:${epoch}:${index}:0`, type: 'thought' as const, content: `Step ${index}`, timestamp: '2026-08-03T00:00:00.000Z' });
  const details = (events: LiveDetails['events']): LiveDetails => ({ events, todos: [], currentTask: null });

  it('retains readable prefixes, missing middle events, and suffixes on HTTP and socket full reads', () => {
    const previous = details([event(1, 0), event(1, 1), event(1, 2), event(1, 3), event(1, 4)]);
    const full = details([event(1, 1), event(1, 3)]);
    expect(mergeFullLiveDetails(previous, full).events).toEqual(previous.events);
    expect(applyTaskLiveUpdate(previous, { taskId: 'task', events: [event(1, 1), event(1, 3)], todos: [], currentTask: null, omittedEventCount: 0 }).events).toEqual(previous.events);
  });

  it('uses execution identity even when trimming leaves no shared event', () => {
    const previous = details([event(1, 0)]);
    expect(mergeFullLiveDetails(previous, details([event(1, 1)])).events).toEqual([event(1, 0), event(1, 1)]);
    expect(mergeFullLiveDetails(previous, details([event(2, 1)])).events).toEqual([event(2, 1)]);
  });
});

describe('goal live refresh races', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketMocks.isConnected = true;
    socketMocks.liveUpdateHandler = null;
    apiMocks.getTaskLiveDetails.mockResolvedValue({ events: [], todos: [], currentTask: null });
  });

  it('uses push while connected, polls only offline, and reconciles reconnect and visibility', async () => {
    vi.useFakeTimers();
    const { rerender, unmount } = renderHook(() => useTaskLiveData('task', 5_000));
    try {
      await act(async () => {});
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(1);
      socketMocks.isConnected = false;
      rerender();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
      expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(2);
      socketMocks.isConnected = true;
      rerender();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(3);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
      expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(3);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(4);
    } finally {
      unmount();
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      vi.useRealTimers();
    }
  });

  it('does not overlap disconnected fallback reads', async () => {
    vi.useFakeTimers();
    socketMocks.isConnected = false;
    const pending = deferred<LiveDetails>();
    apiMocks.getTaskLiveDetails.mockReturnValueOnce(pending.promise);
    const { unmount } = renderHook(() => useTaskLiveData('task', 5_000));
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(15_100); });
      expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(1);
      await act(async () => { pending.resolve({ events: [], todos: [], currentTask: null }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it('preserves grown messages and metadata received during a pending read while adding snapshot history', async () => {
    const read = deferred<LiveDetails>();
    apiMocks.getTaskLiveDetails.mockReturnValue(read.promise);
    const { result, unmount } = renderHook(() => useTaskLiveData('task', 0));
    act(() => socketMocks.liveUpdateHandler?.({
      taskId: 'task', events: [{ id: 'a', type: 'thought', content: 'Checking the parser' }],
      todos: [], currentTask: null, tokenUsage: { input_tokens: 20, output_tokens: 10 },
    }));
    await act(async () => {
      read.resolve({ events: [{ id: 'history', type: 'thought', content: 'Earlier history' }, { id: 'a', type: 'thought', content: 'Checking' }],
        todos: [{ id: 'old', content: 'Old todo', status: 'pending' }], currentTask: 'Old task', tokenUsage: { input_tokens: 10, output_tokens: 2 } });
      await read.promise;
    });
    expect(result.current.liveDetails.events.map(event => event.content)).toEqual(['Earlier history', 'Checking the parser']);
    expect(result.current.liveDetails.todos).toEqual([]);
    expect(result.current.liveDetails.currentTask).toBeNull();
    expect(result.current.liveDetails.tokenUsage?.input_tokens).toBe(20);
    unmount();
  });

  it('preserves an execution reset received during the HTTP read', async () => {
    const read = deferred<LiveDetails>();
    apiMocks.getTaskLiveDetails.mockReturnValue(read.promise);
    const { result, unmount } = renderHook(() => useTaskLiveData('task', 0));
    const events = [{ id: 'live:task:redis:2:0:0', type: 'thought' as const, content: 'New execution' }];
    act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events, todos: [], currentTask: null, omittedEventCount: 0 }));
    await act(async () => {
      read.resolve({ events: [{ id: 'live:task:redis:1:0:0', type: 'thought', content: 'Old execution' }], todos: [], currentTask: null });
      await read.promise;
    });
    expect(result.current.liveDetails.events).toEqual(events);
    unmount();
  });

  it('ignores an older HTTP response when refreshes complete out of order', async () => {
    const older = deferred<LiveDetails>();
    apiMocks.getTaskLiveDetails.mockReturnValueOnce(older.promise);
    const { result, unmount } = renderHook(() => useTaskLiveData('task', 0));
    const newest: LiveDetails = { events: [{ id: 'a', type: 'thought', content: 'Newer HTTP state' }], todos: [], currentTask: null };
    apiMocks.getTaskLiveDetails.mockResolvedValue(newest);
    await act(async () => { await result.current.refreshLiveDetails(); });
    await act(async () => {
      older.resolve({ ...newest, events: [{ id: 'a', type: 'thought', content: 'Older HTTP state' }] });
      await older.promise;
    });
    expect(result.current.liveDetails.events).toEqual(newest.events);
    unmount();
  });

  it('ignores responses for the previous task', async () => {
    const oldRead = deferred<LiveDetails>();
    apiMocks.getTaskLiveDetails.mockReturnValueOnce(oldRead.promise);
    const { result, rerender, unmount } = renderHook(({ task }) => useTaskLiveData(task, 0), { initialProps: { task: 'old' } });
    await act(async () => { await result.current.refreshLiveDetails(); });
    rerender({ task: 'new' });
    act(() => socketMocks.liveUpdateHandler?.({ taskId: 'new', events: [{ id: 'new', type: 'thought', content: 'New task' }] }));
    await act(async () => {
      oldRead.resolve({ events: [{ id: 'old', type: 'thought', content: 'Old task' }], todos: [], currentTask: null });
      await oldRead.promise;
    });
    expect(result.current.liveDetails.events.map(event => event.id)).toEqual(['new']);
    unmount();
  });
});

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveDetails } from './types';
import { useTaskLiveData } from './useTaskLiveData';
import { useTaskData, applyTaskLiveUpdate, mergeFullLiveDetails } from './useTaskData';

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

const toastMocks = vi.hoisted(() => ({ addToast: vi.fn() }));

vi.mock('../../api/proprApi', () => apiMocks);
vi.mock('../ui/useToast', () => ({ useToast: () => toastMocks }));
vi.mock('../../contexts/useSocket', () => ({ useSocket: () => socketMocks }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const raw = (index: number) => ({ id: `live:task:redis:1:${index}:0`, type: 'tool_use' as const, toolName: 'Bash', timestamp: '2026-09-27T00:00:00Z' });
const details = (start: number, count: number, omittedEventCount = start): LiveDetails => ({
  events: Array.from({ length: count }, (_, index) => raw(start + index)), todos: [], currentTask: null, omittedEventCount,
});

function expectHistory(actual: LiveDetails, expected: LiveDetails) {
  expect(actual.events).toEqual(expected.events);
  expect(actual.omittedEventCount).toBe(expected.omittedEventCount);
}

type Page = 'goal' | 'task';
async function renderPage(page: Page, state = 'CLAUDE_EXECUTION') {
  vi.useFakeTimers();
  if (page === 'task') apiMocks.getTaskHistory.mockResolvedValueOnce({ history: [{ state }] });
  const usePage: () => { liveDetails: LiveDetails; refreshLiveDetails?: () => Promise<LiveDetails | null> } = page === 'goal' ? () => useTaskLiveData('task', 0, state.toLowerCase()) : () => useTaskData('task');
  const hook = renderHook(usePage);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return {
    ...hook,
    refresh: async () => {
      if (page === 'goal') act(() => { void hook.result.current.refreshLiveDetails!(); });
      else act(() => socketMocks.taskUpdateHandler?.({ taskId: 'task', state: 'COMPLETED' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    },
  };
}

describe('full history follow-up regressions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    socketMocks.isConnected = true;
    socketMocks.liveUpdateHandler = null;
    socketMocks.taskUpdateHandler = null;
    apiMocks.getTaskHistory.mockResolvedValue({ history: [{ state: 'COMPLETED' }], taskInfo: null });
    apiMocks.getTaskLiveDetails.mockResolvedValue(details(0, 510));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('counts rolling HTTP omissions once and retains readable prefixes and newer increments', () => {
    const thought = { id: 'live:task:redis:1:thought:0', type: 'thought' as const, content: 'Earlier reasoning' };
    const previous = { ...details(100, 502), events: [thought, ...details(100, 502).events] };
    const full = details(101, 500);
    const merged = mergeFullLiveDetails(previous, full);
    expect(merged.events).toEqual([thought, ...details(102, 500).events]);
    expect(merged.omittedEventCount).toBe(102); // 101 from HTTP, plus event 101 displaced by increment 601.
    const polling = mergeFullLiveDetails(details(100, 500), full);
    expectHistory(polling, full);
    expect(mergeFullLiveDetails(polling, full).omittedEventCount).toBe(101);
    const noOverlap = mergeFullLiveDetails(details(0, 500), details(500, 500));
    expectHistory(noOverlap, details(500, 500));
    const newerWithoutOverlap = mergeFullLiveDetails(details(601, 1), full);
    expectHistory(newerWithoutOverlap, details(102, 500));
  });

  it('does not mistake omitted raw suffixes after an old shared thought for newer increments', () => {
    const thought = { id: 'live:task:redis:1:thought:0', type: 'thought' as const, content: 'Earlier reasoning' };
    const old = { ...details(100, 1), events: [thought, raw(100)] };
    const full = { ...details(101, 500), events: [thought, ...details(101, 500).events] };
    expect(mergeFullLiveDetails(old, full)).toEqual({ ...full, tokenUsage: null });
  });

  it('preserves completed HTTP history and socket increments arriving during that read', async () => {
    const pending = deferred<LiveDetails>();
    apiMocks.getTaskLiveDetails.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useTaskData('task'));
    await act(async () => {});
    act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [raw(510)] }));
    await act(async () => { pending.resolve(details(0, 510)); await pending.promise; });
    expectHistory(result.current.liveDetails, details(0, 511, 0));
  });

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'])('keeps uncapped HTTP history in the task hook for %s', async state => {
    apiMocks.getTaskHistory.mockResolvedValue({ history: [{ state }], taskInfo: null });
    const { result } = renderHook(() => useTaskData('task'));
    await act(async () => {});
    expect(result.current.liveDetails.events).toEqual(details(0, 510).events);
    expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(1);
    expect(result.current.liveDetails.omittedEventCount).toBe(0);
    act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [raw(510)] }));
    expect(result.current.liveDetails.events).toHaveLength(511);
    // A delayed live full-state payload must not discard already loaded completed history.
    act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', ...details(11, 500) }));
    expect(result.current.liveDetails.events).toHaveLength(511);
    expect(result.current.liveDetails.omittedEventCount).toBe(0);
  });

  it.each([false, true])('refetches on task completion with initial HTTP pending=%s', async pending => {
    const liveRead = deferred<LiveDetails>();
    apiMocks.getTaskLiveDetails.mockReturnValueOnce(pending ? liveRead.promise : Promise.resolve(details(10, 500)));
    const { result, refresh } = await renderPage('task');
    if (!pending) expect(result.current.liveDetails.events).toHaveLength(500);
    await refresh();
    await act(async () => { liveRead.resolve(details(10, 500)); await liveRead.promise; });
    expectHistory(result.current.liveDetails, details(0, 510, 0));
    expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(2);
  });

  it('keeps uncapped completed goal history through HTTP, socket updates, and polling', async () => {
    const { result } = renderHook(() => useTaskLiveData('task', 0, 'completed'));
    await act(async () => {});
    expect(result.current.liveDetails.events).toEqual(details(0, 510).events);
    act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [raw(510)] }));
    await act(async () => { await result.current.refreshLiveDetails(); });
    expect(result.current.liveDetails.events).toHaveLength(511);
    expect(result.current.liveDetails.omittedEventCount).toBe(0);
  });

  for (const pollIntervalMs of [0, 5_000]) {
    it.each(['completed', 'failed', 'cancelled'])(`immediately restores goal history on %s with polling interval ${pollIntervalMs}`, async state => {
      vi.useFakeTimers();
      apiMocks.getTaskLiveDetails.mockResolvedValueOnce(details(10, 500));
      const { result, rerender } = renderHook(
        ({ state }) => useTaskLiveData('task', pollIntervalMs, state),
        { initialProps: { state: 'claude_execution' } },
      );
      await act(async () => {});
      expectHistory(result.current.liveDetails, details(10, 500, 10));

      rerender({ state });
      // No timer tick or manual refresh: the lifecycle transition starts the read.
      expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(2);
      await act(async () => {});
      expectHistory(result.current.liveDetails, details(0, 510, 0));
    });

    it.each(['active first', 'completion first'])(`supersedes the pending active goal read with polling interval ${pollIntervalMs} (%s)`, async order => {
      vi.useFakeTimers();
      const stale = deferred<LiveDetails>();
      const completed = deferred<LiveDetails>();
      apiMocks.getTaskLiveDetails.mockReturnValueOnce(stale.promise).mockReturnValueOnce(completed.promise);
      const { result, rerender } = renderHook(
        ({ state }) => useTaskLiveData('task', pollIntervalMs, state),
        { initialProps: { state: 'claude_execution' } },
      );
      expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(1);
      rerender({ state: 'completed' });
      expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(2);

      const resolveStale = async () => {
        await act(async () => {
          stale.resolve({ ...details(10, 500), currentTask: 'Still executing' });
          await stale.promise;
        });
      };
      if (order === 'active first') {
        await resolveStale();
        expect(result.current.liveDetails.events).toEqual([]);
        expect(result.current.liveDetails.currentTask).toBeNull();
      }
      // The obsolete read's cleanup must not clear the completion read's socket buffer.
      act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [raw(510)] }));
      await act(async () => { completed.resolve(details(0, 510)); await completed.promise; });
      expectHistory(result.current.liveDetails, details(0, 511, 0));
      if (order === 'completion first') await resolveStale();
      expectHistory(result.current.liveDetails, details(0, 511, 0));
      expect(result.current.liveDetails.currentTask).toBeNull();
    });
  }

  it('keeps the live goal polling omission count accurate without socket delivery', async () => {
    apiMocks.getTaskLiveDetails.mockResolvedValueOnce(details(100, 500)).mockResolvedValue(details(101, 500));
    const { result } = renderHook(() => useTaskLiveData('task', 0, 'claude_execution'));
    await act(async () => {});
    await act(async () => { await result.current.refreshLiveDetails(); });
    expectHistory(result.current.liveDetails, details(101, 500, 101));
  });

  it('keeps output discarded by retention disclosed across increments until full state says otherwise', async () => {
    const truncated = applyTaskLiveUpdate(details(0, 0), { taskId: 'task', events: [raw(900)], omittedEventCount: 0, historyTruncated: true });
    expect(truncated.omittedEventCount).toBe(0);
    expect(truncated.historyTruncated).toBe(true);
    const increment = applyTaskLiveUpdate(truncated, { taskId: 'task', events: [raw(901)] });
    expect(increment.historyTruncated).toBe(true);
    expect(mergeFullLiveDetails(increment, { ...details(900, 2, 0), historyTruncated: true }).historyTruncated).toBe(true);
    expect(applyTaskLiveUpdate(increment, { taskId: 'task', events: [raw(0)], omittedEventCount: 0 }).historyTruncated).toBeUndefined();

    apiMocks.getTaskLiveDetails.mockResolvedValue({ ...details(900, 2, 0), historyTruncated: true });
    const { result } = renderHook(() => useTaskLiveData('task', 0, 'running'));
    await act(async () => {});
    expect(result.current.liveDetails.omittedEventCount).toBe(0);
    expect(result.current.liveDetails.historyTruncated).toBe(true);
  });

  it('merges large full histories, including unshared prefixes and suffixes, without positional arguments', () => {
    const events = Array.from({ length: 150_000 }, (_, index) => ({ ...raw(index), type: 'thought' as const, content: 'x' }));
    const full = { ...details(0, 0), events };
    const empty = details(0, 0);
    expect(mergeFullLiveDetails(empty, full).events).toEqual(events);
    const last = { ...full, events: [events.at(-1)!] };
    const first = { ...full, events: [events[0]] };
    expect(mergeFullLiveDetails(full, last).events).toEqual(events);
    expect(mergeFullLiveDetails(full, first).events).toEqual(events);
    const next = { ...full, events: [{ ...events[0], id: 'live:task:redis:1:new:0' }] };
    expect(mergeFullLiveDetails(full, next).events).toHaveLength(events.length + 1);
    expect(applyTaskLiveUpdate(empty, { taskId: 'task', events, omittedEventCount: 0 }).events).toEqual(events);
  });

  it.each<Page>(['goal', 'task'])('%s page replays a large increment once during HTTP/completion', async page => {
    const read = deferred<LiveDetails>();
    if (page === 'goal') apiMocks.getTaskLiveDetails.mockResolvedValueOnce(details(0, 100, 0));
    apiMocks.getTaskLiveDetails.mockReturnValueOnce(read.promise).mockReturnValue(new Promise(() => {}));
    const { result, refresh } = await renderPage(page);
    if (page === 'goal') {
      expect(result.current.liveDetails.events).toEqual(details(0, 100).events);
      await refresh();
    }
    act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: details(100, 600).events }));
    expect(result.current.liveDetails.events).toEqual(details(200, 500).events);
    if (page === 'task') await refresh();
    // The snapshot predates most of the increment, which evicted events 100-199.
    await act(async () => { read.resolve(details(0, page === 'goal' ? 150 : 100, 0)); await read.promise; });
    expect(result.current.liveDetails.events).toEqual(details(page === 'goal' ? 200 : 0, page === 'goal' ? 500 : 700).events);
    expect(result.current.liveDetails.omittedEventCount).toBe(page === 'goal' ? 200 : 0);
  });

  const message = (content: string) => ({ id: 'live:task:redis:gen%3A1:40:0', type: 'thought' as const, content });
  const at = (offset: number) => ({ epoch: 'gen:1', offset });
  const growing = (content: string, offset: number): LiveDetails => ({
    events: [message(content)], todos: [], currentTask: null, omittedEventCount: 0, liveOutputPosition: at(offset),
  });

  for (const [ordering, socketOffset, expected] of [
    ['HTTP past socket', 60, 'Checking the parser'],
    ['socket past HTTP', 140, 'Checking the parser and tests'],
  ] as const) {
    it.each<Page>(['goal', 'task'])(`%s page orders growing messages: ${ordering}`, async page => {
      const read = deferred<LiveDetails>();
      if (page === 'goal') apiMocks.getTaskLiveDetails.mockResolvedValueOnce(growing('Check', 50));
      apiMocks.getTaskLiveDetails.mockReturnValueOnce(read.promise).mockReturnValue(new Promise(() => {}));
      const { result, refresh } = await renderPage(page);
      if (page === 'goal') await refresh();
      const socketContent = socketOffset > 100 ? 'Checking the parser and tests' : 'Checking';
      act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [message(socketContent)], liveOutputPosition: at(socketOffset) }));
      if (page === 'task') await refresh();
      await act(async () => { read.resolve(growing('Checking the parser', 100)); await read.promise; });
      expect(result.current.liveDetails.events).toEqual([message(expected)]);
    });
  }

  for (const page of ['goal', 'finished task']) {
    for (const fullState of [true, false]) {
      it(`${page}: retains history from a covered ${fullState ? 'snapshot' : 'increment'} received during HTTP`, async () => {
        const read = deferred<LiveDetails>();
        apiMocks.getTaskLiveDetails.mockReturnValueOnce(read.promise).mockReturnValue(new Promise(() => {}));
        const { result } = await renderPage(page === 'goal' ? 'goal' : 'task', page === 'goal' ? 'CLAUDE_EXECUTION' : 'COMPLETED');
        const lost = { ...message('Earlier readable history'), id: 'live:task:redis:gen%3A1:20:0' };
        act(() => socketMocks.liveUpdateHandler?.({
          taskId: 'task', events: [lost, message('Check')], currentTask: 'Old task',
          ...(fullState ? { omittedEventCount: 0 } : {}), liveOutputPosition: at(60),
        }));
        expect(result.current.liveDetails.events).toContainEqual(lost);
        const newer = { ...growing('Checking the parser', 100), currentTask: 'New task', historyTruncated: true };
        await act(async () => { read.resolve(newer); await read.promise; });
        expect(result.current.liveDetails).toMatchObject({
          ...newer, events: [lost, message('Checking the parser')],
        });
      });
    }
  }

  describe('socket updates arriving after a newer full read', () => {
    const lateWatcherState = {
      taskId: 'task', events: [message('Check')], todos: [{ id: 'todo', content: 'Read parser', status: 'in_progress' }],
      currentTask: 'Reading', tokenUsage: null, omittedEventCount: 0, liveOutputPosition: at(60),
    };
    const newerRead = (): LiveDetails => ({
      ...growing('Checking the parser', 100),
      todos: [{ id: 'todo', content: 'Read parser', status: 'completed' }], currentTask: 'Done reading',
    });
    const expectNewerRead = (liveDetails: LiveDetails) => expect(liveDetails).toMatchObject(newerRead());

    it.each<Page>(['goal', 'task'])('%s page ignores stale watcher snapshots and increments after HTTP', async page => {
      apiMocks.getTaskLiveDetails.mockResolvedValueOnce(newerRead());
      const { result } = await renderPage(page);
      expectNewerRead(result.current.liveDetails);
      act(() => socketMocks.liveUpdateHandler?.(lateWatcherState));
      act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [message('Checking')], currentTask: 'Reading', liveOutputPosition: at(80) }));
      expectNewerRead(result.current.liveDetails);
      // Later output still applies and advances the position; subsequent stale output cannot undo it.
      act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [message('Checking the parser and tests')], liveOutputPosition: at(140) }));
      expect(result.current.liveDetails.events).toEqual([message('Checking the parser and tests')]);
      expect(result.current.liveDetails.liveOutputPosition).toEqual(at(140));
      act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', events: [message('Checking the parser')], liveOutputPosition: at(120) }));
      expect(result.current.liveDetails.events).toEqual([message('Checking the parser and tests')]);
    });

    it('still applies a new execution and updates without positions', () => {
      const state = mergeFullLiveDetails({ events: [], todos: [], currentTask: null }, newerRead());
      const timestamp = '2026-09-27T00:00:00Z';
      const nextExecution = { id: 'live:task:redis:gen%3A2:0:0', type: 'thought' as const, content: 'Starting over', timestamp };
      expect(applyTaskLiveUpdate(state, {
        taskId: 'task', events: [nextExecution], todos: [], currentTask: null, tokenUsage: null,
        omittedEventCount: 0, liveOutputPosition: { epoch: 'gen:2', offset: 10 },
      })).toMatchObject({ events: [nextExecution], liveOutputPosition: { epoch: 'gen:2', offset: 10 } });
      const unordered = applyTaskLiveUpdate(state, { taskId: 'task', events: [{ ...message('Checking'), timestamp }] });
      expect(unordered.events).toEqual([{ ...message('Checking'), timestamp }]);
      expect(unordered.liveOutputPosition).toBeUndefined();
    });
  });

  describe('buffered updates of an execution a newer read replaced', () => {
    const event = (epoch: number, offset: number) => ({
      id: `live:task:redis:gen%3A${epoch}:${offset}:0`, type: 'thought' as const, content: `Run ${epoch} at ${offset}`, timestamp: '2026-09-27T00:00:00Z',
    });
    const position = (epoch: number, offset: number) => ({ epoch: `gen:${epoch}`, offset });
    const read = (epoch: number, offset: number, todo: string): LiveDetails => ({
      events: [event(epoch, offset)], todos: [{ id: 'todo', content: todo, status: 'in_progress' }], currentTask: todo,
      tokenUsage: null, omittedEventCount: 0, liveOutputPosition: position(epoch, offset),
    });
    const oldTodos = [{ id: 'todo', content: 'Old run', status: 'completed' }];
    const oldUpdates = {
      increment: { taskId: 'task', events: [event(1, 60)], todos: oldTodos, currentTask: 'Old run', liveOutputPosition: position(1, 60) },
      'full state': { taskId: 'task', ...read(1, 60, 'Old run'), todos: oldTodos },
    };
    const expectNewRun = (liveDetails: LiveDetails, events = [event(2, 10)]) =>
      expect(liveDetails).toMatchObject({ ...read(2, events.length * 10, 'New run'), events });
    const newRunIncrement = { taskId: 'task', events: [event(2, 20)], liveOutputPosition: position(2, 20) };

    for (const [kind, oldUpdate] of Object.entries(oldUpdates)) {
      it.each<Page>(['goal', 'task'])(`%s page discards a buffered old ${kind} and its late deliveries after a new-execution read`, async page => {
        const pending = deferred<LiveDetails>();
        apiMocks.getTaskLiveDetails.mockResolvedValueOnce(read(1, 50, 'Old run')).mockReturnValueOnce(pending.promise);
        const { result, refresh } = await renderPage(page);
        expect(result.current.liveDetails.liveOutputPosition).toEqual(position(1, 50));
        await refresh();
        expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(2);
        act(() => socketMocks.liveUpdateHandler?.(oldUpdate));
        await act(async () => { pending.resolve(read(2, 10, 'New run')); await pending.promise; });
        expectNewRun(result.current.liveDetails);
        act(() => socketMocks.liveUpdateHandler?.({ ...oldUpdate, events: [event(1, 70)], liveOutputPosition: position(1, 70) }));
        expectNewRun(result.current.liveDetails);
        act(() => socketMocks.liveUpdateHandler?.(newRunIncrement));
        expectNewRun(result.current.liveDetails, [event(2, 10), event(2, 20)]);
      });
    }

    const expectRun = (liveDetails: LiveDetails, epoch: number, offset: number, todo: string) =>
      expect(liveDetails).toMatchObject(read(epoch, offset, todo));
    const lateIncrement = (epoch: number) => ({ taskId: 'task', events: [event(epoch, 70)], currentTask: 'Old run', liveOutputPosition: position(epoch, 70) });

    it.each<Page>(['goal', 'task'])('%s page keeps the newer initial HTTP execution over buffered and late older executions', async page => {
      const pending = deferred<LiveDetails>();
      apiMocks.getTaskLiveDetails.mockReturnValueOnce(pending.promise).mockReturnValue(new Promise(() => {}));
      const { result } = await renderPage(page, page === 'goal' ? 'CLAUDE_EXECUTION' : 'COMPLETED');
      expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(1);
      act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', ...read(1, 60, 'Old run') }));
      expectRun(result.current.liveDetails, 1, 60, 'Old run');
      await act(async () => { pending.resolve(read(2, 10, 'New run')); await pending.promise; });
      expectRun(result.current.liveDetails, 2, 10, 'New run');
      act(() => socketMocks.liveUpdateHandler?.(lateIncrement(1)));
      expectRun(result.current.liveDetails, 2, 10, 'New run');
    });

    it.each<Page>(['goal', 'task'])('%s page keeps the newer HTTP execution over an intermediate execution received during the read', async page => {
      const pending = deferred<LiveDetails>();
      apiMocks.getTaskLiveDetails.mockResolvedValueOnce(read(1, 50, 'First run')).mockReturnValueOnce(pending.promise);
      const { result, refresh } = await renderPage(page);
      await refresh();
      expect(apiMocks.getTaskLiveDetails).toHaveBeenCalledTimes(2);
      act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', ...read(2, 30, 'Old run') }));
      act(() => socketMocks.liveUpdateHandler?.(lateIncrement(2)));
      await act(async () => { pending.resolve(read(3, 10, 'New run')); await pending.promise; });
      expectRun(result.current.liveDetails, 3, 10, 'New run');
      act(() => socketMocks.liveUpdateHandler?.({ ...lateIncrement(2), events: [event(2, 80)], liveOutputPosition: position(2, 80) }));
      expectRun(result.current.liveDetails, 3, 10, 'New run');
    });

    it('orders executions only within one log generation', () => {
      const state = mergeFullLiveDetails({ events: [], todos: [], currentTask: null }, read(2, 10, 'New run'));
      const update = (epoch: number, offset: number, currentTask: string, liveOutputPosition = position(epoch, offset)) => ({
        taskId: 'task', events: [event(epoch, offset)], todos: [], currentTask, tokenUsage: null, omittedEventCount: 0, liveOutputPosition,
      });
      expect(applyTaskLiveUpdate(state, update(1, 60, 'Old run'))).toBe(state);
      expect(applyTaskLiveUpdate(state, update(10, 5, 'Later run'))).toMatchObject({ currentTask: 'Later run' });
      // A recreated log restarts its counter under a new generation: no ordering evidence, so the update applies.
      const recreated = update(1, 5, 'Recreated run', { epoch: 'other:1', offset: 5 });
      expect(applyTaskLiveUpdate(state, recreated)).toMatchObject({ currentTask: 'Recreated run', liveOutputPosition: { epoch: 'other:1', offset: 5 } });
    });

    it('goal page: a newer execution arriving through the socket during the read still replaces the read', async () => {
      const pending = deferred<LiveDetails>();
      apiMocks.getTaskLiveDetails.mockResolvedValueOnce(read(1, 50, 'Old run')).mockReturnValueOnce(pending.promise);
      const { result, refresh } = await renderPage('goal');
      await refresh();
      act(() => socketMocks.liveUpdateHandler?.(oldUpdates.increment));
      act(() => socketMocks.liveUpdateHandler?.({ taskId: 'task', ...read(3, 5, 'Newest run') }));
      await act(async () => { pending.resolve(read(2, 10, 'New run')); await pending.promise; });
      expect(result.current.liveDetails.events).toEqual([event(3, 5)]);
      expect(result.current.liveDetails.currentTask).toBe('Newest run');
      expect(result.current.liveDetails.liveOutputPosition).toEqual(position(3, 5));
    });
  });
});

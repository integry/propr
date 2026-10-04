/* eslint-disable max-lines -- every case drives the hook through one socket and visibility fixture */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_UPDATE,
  GOAL_UPDATE,
  NOTIFICATION_UPDATE,
  USAGE_UPDATE,
  type ActivityUpdatePayload,
  type GoalUpdatePayload,
  type NotificationUpdatePayload,
  type UsageUpdatePayload,
} from '@propr/shared/dist/activityEvents.js';
import { matchesInterest, useLiveResource } from './useLiveResource';

type Listener<T> = (payload: T) => void;

const socket = vi.hoisted(() => {
  const activity = new Set<Listener<unknown>>();
  const goal = new Set<Listener<unknown>>();
  const notification = new Set<Listener<unknown>>();
  const usage = new Set<Listener<unknown>>();
  const snapshot = new Set<Listener<unknown>>();
  const register = (registry: Set<Listener<unknown>>) => (callback: Listener<never>) => {
    registry.add(callback as Listener<unknown>);
    return () => { registry.delete(callback as Listener<unknown>); };
  };
  return {
    listeners: { activity, goal, notification, usage, snapshot },
    // One object identity for every render: the real provider also hands out
    // stable callbacks, and an unstable one would hide subscription churn.
    value: {
      isConnected: true,
      shellSnapshots: false,
      onShellSnapshot: register(snapshot),
      subscribeToActivity: vi.fn(),
      unsubscribeFromActivity: vi.fn(),
      onActivityUpdate: register(activity),
      onGoalUpdate: register(goal),
      onNotificationUpdate: register(notification),
      onUsageUpdate: register(usage),
    },
  };
});

vi.mock('../contexts/useSocket', () => ({ useSocket: () => socket.value }));

const setVisibility = (value: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
};

const activityEvent = (over: Partial<ActivityUpdatePayload> = {}): ActivityUpdatePayload => ({
  eventType: ACTIVITY_UPDATE,
  domain: 'task',
  change: 'completed',
  entityId: 'task-1',
  repository: 'acme/app',
  terminal: true,
  occurredAt: '2026-09-26T10:00:00.000Z',
  ...over,
});

/** Advance only microtasks, so a burst is never split by the coalescing timer. */
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

const emitActivity = async (payload: ActivityUpdatePayload) => {
  await act(async () => {
    socket.listeners.activity.forEach(listener => listener(payload));
    await Promise.resolve();
  });
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

describe('useLiveResource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
    socket.value.isConnected = true;
    socket.value.shellSnapshots = false;
    socket.value.subscribeToActivity.mockClear();
    socket.value.unsubscribeFromActivity.mockClear();
    Object.values(socket.listeners).forEach(registry => registry.clear());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies pushed snapshots without HTTP on usage events or connected timers', async () => {
    socket.value.shellSnapshots = true;
    const read = vi.fn(async () => ({ enabled: false }));
    const { result, rerender } = renderHook(() => useLiveResource({
      read, scopeKey: 'usage', interest: { usage: true }, snapshotResource: 'usage',
    }));
    await flush();
    for (let index = 0; index < 30; index++) {
      await act(async () => {
        socket.listeners.snapshot.forEach(listener => listener({ resource: 'usage', data: { enabled: true } }));
        socket.listeners.usage.forEach(listener => listener({ eventType: 'usage:update' }));
      });
      await advance(20_000);
    }
    expect(result.current.data).toEqual({ enabled: true });
    expect(read).toHaveBeenCalledTimes(1);
    socket.value.isConnected = false;
    socket.value.shellSnapshots = false;
    rerender();
    await advance(30_100);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads once on mount and collapses a burst of matching events into one read', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    renderHook(() => useLiveResource({
      read,
      scopeKey: 'acme/app',
      interest: { domains: ['task'], repository: 'acme/app' },
    }));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 10; index += 1) {
      await emitActivity(activityEvent({ entityId: `task-${index}` }));
    }
    await advance(100);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('drops events outside the declared repository and domains without reading', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    renderHook(() => useLiveResource({
      read,
      scopeKey: 'acme/app',
      interest: { domains: ['task'], repository: 'acme/app' },
    }));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    await emitActivity(activityEvent({ repository: 'acme/other' }));
    await emitActivity(activityEvent({ domain: 'indexing' }));
    await emitActivity(activityEvent({ change: 'progressed', repository: 'acme/other' }));
    await advance(30_100);

    // The filter is the point: an irrelevant event must not cost a request.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('honours an instance-wide event and a narrowed change list', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    renderHook(() => useLiveResource({
      read,
      scopeKey: 'acme/app',
      interest: { domains: ['task'], changes: ['completed'], repository: 'acme/app' },
    }));
    await flush();

    await emitActivity(activityEvent({ change: 'started' }));
    await advance(100);
    expect(read).toHaveBeenCalledTimes(1);

    // repository null is instance-wide, so it is relevant to every scope.
    await emitActivity(activityEvent({ repository: null }));
    await advance(100);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reconciles exactly once per reconnect, not once per queued event', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    const { rerender } = renderHook(() => useLiveResource({
      read,
      scopeKey: 'all',
      interest: { domains: ['task'] },
    }));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    socket.value.isConnected = false;
    rerender();
    await advance(100);
    expect(read).toHaveBeenCalledTimes(1);

    socket.value.isConnected = true;
    socket.value.shellSnapshots = false;
    rerender();
    await emitActivity(activityEvent({ repository: null, entityId: 'queued-1' }));
    await emitActivity(activityEvent({ repository: null, entityId: 'queued-2' }));
    await advance(100);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('uses frequent fallback polls only while disconnected', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    socket.value.isConnected = false;
    const { rerender } = renderHook(() => useLiveResource({
      read,
      scopeKey: 'all',
      interest: { domains: ['task'] },
    }));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    await advance(30_100);
    expect(read).toHaveBeenCalledTimes(2);
    await advance(30_100);
    expect(read).toHaveBeenCalledTimes(3);

    socket.value.isConnected = true;
    socket.value.shellSnapshots = false;
    rerender();
    await advance(100);
    expect(read).toHaveBeenCalledTimes(4);

    // Normal fallback polls stop; connected safety reads are much less frequent.
    await advance(120_000);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('recovers a lost publication while connected and keeps hidden or disabled scopes quiet', async () => {
    let value = 'pending';
    let disabled = false;
    const read = vi.fn(async () => value);
    const { result, rerender, unmount } = renderHook(() => useLiveResource({
      read, scopeKey: 'goal', interest: { goals: true }, disabled,
    }));
    await flush();
    value = 'completed'; // Committed change, with no delivered event.
    await advance(299_999);
    expect(read).toHaveBeenCalledTimes(1);
    await advance(101);
    expect(result.current.data).toBe('completed');
    expect(read).toHaveBeenCalledTimes(2);
    setVisibility('hidden');
    await advance(600_000);
    expect(read).toHaveBeenCalledTimes(2);
    setVisibility('visible');
    disabled = true; rerender();
    await advance(600_000);
    expect(read).toHaveBeenCalledTimes(2);
    unmount();
    await advance(600_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does no work while the tab is hidden and reconciles once when it becomes visible', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    renderHook(() => useLiveResource({
      read,
      scopeKey: 'all',
      interest: { domains: ['task'] },
    }));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await emitActivity(activityEvent({ repository: null }));
    await emitActivity(activityEvent({ repository: null, entityId: 'task-2' }));
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await advance(100);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('discards the previous scope in-flight request and never applies its result', async () => {
    const pendingA = deferred<{ rows: string }>();
    const signals: AbortSignal[] = [];
    let scopeKey = 'acme/a';
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return scopeKey === 'acme/a' ? pendingA.promise : Promise.resolve({ rows: 'b' });
    });
    const { result, rerender } = renderHook(() => useLiveResource({
      read,
      scopeKey,
      interest: { domains: ['task'] },
    }));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    scopeKey = 'acme/b';
    rerender();
    await flush();
    expect(result.current.data).toEqual({ rows: 'b' });

    await act(async () => { pendingA.resolve({ rows: 'a' }); await Promise.resolve(); });

    expect(result.current.data).toEqual({ rows: 'b' });
    expect(signals[0].aborted).toBe(true);
  });

  it('clears the previous scope rows before the new scope lands', async () => {
    const pendingB = deferred<{ rows: string }>();
    let scopeKey = 'acme/a';
    const read = vi.fn(() => (scopeKey === 'acme/a'
      ? Promise.resolve({ rows: 'a' })
      : pendingB.promise));
    const { result, rerender } = renderHook(() => useLiveResource({
      read,
      scopeKey,
      interest: { domains: ['task'] },
    }));
    await flush();
    expect(result.current.data).toEqual({ rows: 'a' });

    scopeKey = 'acme/b';
    rerender();

    // Another filter's rows must never be shown under the new filter's heading.
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => { pendingB.resolve({ rows: 'b' }); await Promise.resolve(); });
    expect(result.current.data).toEqual({ rows: 'b' });
  });

  it('keeps the last good data when a refresh fails and clears the error on recovery', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ rows: 1 })
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ rows: 2 });
    const { result } = renderHook(() => useLiveResource({
      read,
      scopeKey: 'all',
      interest: { domains: ['task'] },
    }));
    await flush();
    expect(result.current.data).toEqual({ rows: 1 });
    expect(result.current.loading).toBe(false);

    await emitActivity(activityEvent({ repository: null }));
    await advance(100);

    expect(result.current.error).toBe('network down');
    // A failed refresh is not evidence the work vanished.
    expect(result.current.data).toEqual({ rows: 1 });

    await emitActivity(activityEvent({ repository: null, entityId: 'task-3' }));
    await advance(100);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ rows: 2 });
  });

  it('subscribes to goal, notification and usage events only when asked', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    renderHook(() => useLiveResource({
      read,
      scopeKey: 'acme/app',
      interest: { domains: ['task'], repository: 'acme/app', goals: true, usage: true },
    }));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(socket.listeners.notification.size).toBe(0);

    await act(async () => {
      socket.listeners.goal.forEach(listener => listener({
        eventType: GOAL_UPDATE,
        goalId: 'goal-1',
        repository: 'acme/other',
        state: 'completed',
        occurredAt: '2026-09-26T10:00:00.000Z',
      } satisfies GoalUpdatePayload));
      await Promise.resolve();
    });
    await advance(100);
    // A goal in another repository is as irrelevant as a task in one.
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => {
      socket.listeners.goal.forEach(listener => listener({
        eventType: GOAL_UPDATE,
        goalId: 'goal-2',
        repository: 'acme/app',
        state: 'completed',
        occurredAt: '2026-09-26T10:00:00.000Z',
      } satisfies GoalUpdatePayload));
      socket.listeners.usage.forEach(listener => listener({
        eventType: USAGE_UPDATE,
        source: 'agent-tank',
        occurredAt: '2026-09-26T10:00:00.000Z',
      } satisfies UsageUpdatePayload));
      await Promise.resolve();
    });
    await advance(100);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('refreshes on notification events when the caller opts in', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    renderHook(() => useLiveResource({
      read,
      scopeKey: 'inbox',
      interest: { domains: ['notification'], notifications: true },
    }));
    await flush();

    await act(async () => {
      socket.listeners.notification.forEach(listener => listener({
        eventType: NOTIFICATION_UPDATE,
        change: 'created',
        eventId: 'event-1',
        recipientIds: ['user-1'],
        repository: null,
        occurredAt: '2026-09-26T10:00:00.000Z',
      } satisfies NotificationUpdatePayload));
      await Promise.resolve();
    });
    await advance(100);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('joins the activity room while mounted and leaves it on unmount', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    const { unmount } = renderHook(() => useLiveResource({
      read,
      scopeKey: 'all',
      interest: { domains: ['task'] },
    }));
    await flush();
    expect(socket.value.subscribeToActivity).toHaveBeenCalledTimes(1);
    expect(socket.value.unsubscribeFromActivity).not.toHaveBeenCalled();

    unmount();

    expect(socket.value.unsubscribeFromActivity).toHaveBeenCalledTimes(1);
    expect(socket.listeners.activity.size).toBe(0);
  });

  it('keeps usage-only widgets idle for unrelated activity and retains their last good value', async () => {
    const read = vi.fn().mockResolvedValueOnce('good').mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useLiveResource({ read, interest: { usage: true } }));
    await flush();
    expect(result.current.isLoading).toBe(false);
    await emitActivity(activityEvent());
    await advance(100);
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      socket.listeners.usage.forEach(listener => listener({ eventType: USAGE_UPDATE }));
    });
    await advance(100);
    expect(result.current.data).toBe('good');
    expect(result.current.error).toBe('offline');
  });

  it('lets a manual refresh wait until its replacement value has settled', async () => {
    const pending = deferred<string>();
    const read = vi.fn().mockResolvedValueOnce('old').mockImplementationOnce(() => pending.promise);
    const { result } = renderHook(() => useLiveResource({ read, interest: { usage: true } }));
    await flush();
    let settled = false;
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = result.current.refreshNow().then(() => { settled = true; });
    });
    expect(settled).toBe(false);
    await act(async () => { pending.resolve('new'); await refresh; });
    expect(settled).toBe(true);
    expect(result.current.data).toBe('new');
  });

  it('issues no request at all while disabled', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    const { result } = renderHook(() => useLiveResource({
      read,
      scopeKey: 'all',
      interest: { domains: ['task'] },
      disabled: true,
    }));
    await advance(60_000);

    expect(read).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(socket.value.subscribeToActivity).not.toHaveBeenCalled();
  });
});

describe('hidden initial scopes', () => {
  it('defers mounting and scope changes, then reads only the latest scope', async () => {
    vi.useFakeTimers();
    setVisibility('hidden');
    const read = vi.fn(async () => 'latest');
    const { result, rerender, unmount } = renderHook(({ scope }) => useLiveResource({
      read, scopeKey: scope, interest: { goals: true },
    }), { initialProps: { scope: 'first' } });
    await flush();
    rerender({ scope: 'second' });
    await advance(60_000);
    expect(read).not.toHaveBeenCalled();
    setVisibility('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await advance(100);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe('latest');
    unmount();
    vi.useRealTimers();
  });
});


it('accepts both health event vocabularies without treating indexing progress as a health change', () => {
  const interest = { domains: ['health', 'system', 'indexing'], changes: ['updated', 'completed'] } as const;
  expect(matchesInterest(activityEvent({ domain: 'system', change: 'progressed' }), interest)).toBe(true);
  expect(matchesInterest({ eventType: ACTIVITY_UPDATE, domain: 'health', change: 'updated',
    occurredAt: new Date(0).toISOString() }, interest)).toBe(true);
  expect(matchesInterest(activityEvent({ domain: 'indexing', change: 'progressed' }), interest)).toBe(false);
  expect(matchesInterest({ eventType: ACTIVITY_UPDATE, domain: 'indexing', change: 'progress',
    occurredAt: new Date(0).toISOString() }, interest)).toBe(false);
});

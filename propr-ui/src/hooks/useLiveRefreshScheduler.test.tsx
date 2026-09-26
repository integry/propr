import { act, renderHook } from '@testing-library/react';
import { StrictMode, useEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveRefreshScheduler } from './useLiveRefreshScheduler';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe('useLiveRefreshScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reduces the three-request fixture burst to one and performs one trailing refresh for changes during a pending fetch', async () => {
    const first = deferred();
    const refresh = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useLiveRefreshScheduler({ isConnected: true, refresh }));

    act(() => {
      result.current();
      result.current();
      result.current();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => {
      result.current();
      result.current();
    });
    await act(async () => first.resolve());
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('coordinates an immediate initial read with live invalidations', async () => {
    const initial = deferred();
    const refresh = vi.fn()
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useLiveRefreshScheduler({ isConnected: true, refresh }));

    let initialRead!: Promise<void>;
    act(() => {
      initialRead = result.current.refreshNow();
    });
    await act(async () => { await Promise.resolve(); });
    expect(refresh).toHaveBeenCalledOnce();

    act(() => {
      result.current();
      result.current();
    });
    await act(async () => initial.resolve());
    await act(async () => { await initialRead; });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('shares the immediate initial read across the Strict Mode effect replay', async () => {
    const initial = deferred();
    const refresh = vi.fn().mockReturnValue(initial.promise);
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    renderHook(() => {
      const schedule = useLiveRefreshScheduler({ isConnected: true, refresh, scopeKey: 'task-1' });
      useEffect(() => { void schedule.refreshNow(); }, [schedule]);
    }, { wrapper });

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(refresh).toHaveBeenCalledOnce();
    await act(async () => initial.resolve());
  });

  it('discards queued work for the previous scope when navigating to another task', async () => {
    const refreshA = vi.fn().mockResolvedValue(undefined);
    const refreshB = vi.fn().mockResolvedValue(undefined);
    let taskId = 'task-a';
    const { result, rerender } = renderHook(() => useLiveRefreshScheduler({
      isConnected: true,
      scopeKey: taskId,
      refresh: taskId === 'task-a' ? refreshA : refreshB,
    }));

    act(() => result.current());
    taskId = 'task-b';
    rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(refreshA).not.toHaveBeenCalled();
    expect(refreshB).not.toHaveBeenCalled();

    await act(async () => { await result.current.refreshNow(); });
    expect(refreshB).toHaveBeenCalledOnce();
  });

  it('does no hidden work, then coalesces visibility and focus recovery', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useLiveRefreshScheduler({ isConnected: true, refresh }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => {
      result.current();
      result.current();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(refresh).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('recovers on reconnect and retains a disconnected polling fallback', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    let connected = false;
    const { rerender } = renderHook(() => useLiveRefreshScheduler({ isConnected: connected, refresh }));

    await act(async () => { await vi.advanceTimersByTimeAsync(30_100); });
    expect(refresh).toHaveBeenCalledOnce();

    connected = true;
    rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

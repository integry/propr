import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityUpdatePayload, UsageUpdatePayload } from '@propr/shared';
import { useLiveResource } from './useLiveResource';

const socketState = vi.hoisted(() => ({
  isConnected: true,
  activityCallbacks: new Set<(payload: ActivityUpdatePayload) => void>(),
  usageCallbacks: new Set<(payload: UsageUpdatePayload) => void>(),
}));

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: socketState.isConnected,
    onActivityUpdate: (callback: (payload: ActivityUpdatePayload) => void) => {
      socketState.activityCallbacks.add(callback);
      return () => socketState.activityCallbacks.delete(callback);
    },
    onNotificationUpdate: () => () => undefined,
    onUsageUpdate: (callback: (payload: UsageUpdatePayload) => void) => {
      socketState.usageCallbacks.add(callback);
      return () => socketState.usageCallbacks.delete(callback);
    },
  }),
}));

const activity = (
  domain: ActivityUpdatePayload['domain'],
  change: ActivityUpdatePayload['change'] = 'updated',
): ActivityUpdatePayload => ({
  eventType: 'activity:update',
  domain,
  change,
  occurredAt: '2026-09-26T12:00:00.000Z',
});

const pushActivity = (payload: ActivityUpdatePayload) => act(() => {
  socketState.activityCallbacks.forEach(callback => callback(payload));
});

describe('useLiveResource', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    socketState.isConnected = true;
    socketState.activityCallbacks.clear();
    socketState.usageCallbacks.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reads once on mount and again only for a change it asked about', async () => {
    const read = vi.fn().mockResolvedValue('first');
    const { result } = renderHook(() => useLiveResource({
      read,
      interest: { domains: ['indexing'] },
    }));

    await waitFor(() => expect(result.current.data).toBe('first'));
    expect(read).toHaveBeenCalledTimes(1);

    read.mockResolvedValue('second');
    await pushActivity(activity('task'));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(read).toHaveBeenCalledTimes(1);

    await pushActivity(activity('indexing'));
    await waitFor(() => expect(result.current.data).toBe('second'));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('narrows an interest to the kinds of change it was given', async () => {
    const read = vi.fn().mockResolvedValue('value');
    renderHook(() => useLiveResource({
      read,
      interest: { domains: ['task'], changes: ['completed', 'failed'] },
    }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    await pushActivity(activity('task', 'progress'));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(read).toHaveBeenCalledTimes(1);

    await pushActivity(activity('task', 'failed'));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it('keeps the last good value when a refresh fails', async () => {
    const read = vi.fn().mockResolvedValueOnce('good').mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useLiveResource({ read, interest: { usage: true } }));
    await waitFor(() => expect(result.current.data).toBe('good'));

    act(() => { socketState.usageCallbacks.forEach(callback => callback({
      eventType: 'usage:update', occurredAt: '2026-09-26T12:01:00.000Z',
    })); });

    await waitFor(() => expect(result.current.error?.message).toBe('offline'));
    expect(result.current.data).toBe('good');
  });

  it('issues nothing while hidden and reconciles once when visible again', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const read = vi.fn().mockResolvedValue('value');
    renderHook(() => useLiveResource({ read, interest: { domains: ['indexing'] } }));

    await pushActivity(activity('indexing'));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(read).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });

    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('polls only while the socket is unavailable', async () => {
    socketState.isConnected = false;
    const read = vi.fn().mockResolvedValue('value');
    vi.useFakeTimers();
    const { rerender } = renderHook(() => useLiveResource({ read, interest: { usage: true } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_100); });
    expect(read).toHaveBeenCalledTimes(2);

    // Reconnecting reconciles once, and then the interval stops firing.
    socketState.isConnected = true;
    rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(read).toHaveBeenCalledTimes(3);

    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(read).toHaveBeenCalledTimes(3);
  });
});

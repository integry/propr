import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { SocketContext, type SocketContextValue } from '../../contexts/SocketContext';
import { useDashboardSection } from './sectionState';
const visibility = (value: string) => Object.defineProperty(document, 'visibilityState', { configurable: true, value });
afterEach(() => { visibility('visible'); vi.useRealTimers(); });
it('defers hidden mounts and scope changes, discarding a previous scope result', async () => {
  vi.useFakeTimers();
  visibility('hidden');
  let resolve!: (value: string) => void;
  const oldRead = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  const latestRead = vi.fn(async () => 'latest');
  const { result, rerender } = renderHook(({ scope, read }) => useDashboardSection(read, scope, 0),
    { initialProps: { scope: 'old', read: oldRead } });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(oldRead).not.toHaveBeenCalled();
  visibility('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(oldRead).toHaveBeenCalledTimes(1);
  visibility('hidden');
  rerender({ scope: 'new', read: latestRead });
  await act(async () => { resolve('obsolete'); await vi.advanceTimersByTimeAsync(60_000); });
  expect(latestRead).not.toHaveBeenCalled();
  expect(result.current.data).toBeNull();
  visibility('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(latestRead).toHaveBeenCalledTimes(1);
  expect(result.current.data).toBe('latest');
});

it('reconciles a missed dashboard publication while the socket remains connected', async () => {
  vi.useFakeTimers();
  let completed = 0;
  const read = vi.fn(async () => completed);
  const wrapper = ({ children }: { children: ReactNode }) =>
    <SocketContext.Provider value={{ isConnected: true } as SocketContextValue}>{children}</SocketContext.Provider>;
  const { result } = renderHook(() => useDashboardSection(read, 'all', 0), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.data).toBe(0);
  completed = 1;
  await act(async () => { await vi.advanceTimersByTimeAsync(300_100); });
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.current.data).toBe(1);
});

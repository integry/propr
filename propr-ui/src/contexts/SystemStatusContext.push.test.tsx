import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { SystemStatusProvider, useSharedSystemStatus } from './SystemStatusContext';
import type { ShellSnapshot } from './SocketContext';
import type { SystemStatus } from '../api/proprTypes';

const state = vi.hoisted(() => ({
  getSystemStatus: vi.fn(),
  snapshots: new Set<(payload: ShellSnapshot) => void>(),
}));
vi.mock('../api/proprApi', () => ({
  getSystemStatus: state.getSystemStatus,
  INSTANCE_AUTHORIZATION_CHANGED_EVENT: 'authorization-changed',
}));
vi.mock('../api/apiClient', () => ({
  getDesktopSocketConfigurationKey: () => 'browser',
  subscribeDesktopConnectionScope: () => () => {},
}));
vi.mock('./AuthContext', () => ({ useCurrentUser: () => ({ id: 'user' }) }));
vi.mock('./useSocket', () => ({ useOptionalSocket: () => ({
  isConnected: true, shellSnapshots: true,
  onShellSnapshot: (callback: (payload: ShellSnapshot) => void) => {
    state.snapshots.add(callback);
    return () => state.snapshots.delete(callback);
  },
}) }));
afterEach(() => { vi.useRealTimers(); state.getSystemStatus.mockReset(); });

it('renders pushed health, rejects an older HTTP response, and stays quiet while connected', async () => {
  vi.useFakeTimers();
  let finish!: (status: SystemStatus) => void;
  state.getSystemStatus.mockReturnValue(new Promise<SystemStatus>(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useSharedSystemStatus(), {
    wrapper: ({ children }) => <MemoryRouter><SystemStatusProvider>{children}</SystemStatusProvider></MemoryRouter>,
  });
  await act(async () => { await Promise.resolve(); });
  await act(async () => {
    state.snapshots.forEach(callback => callback({ resource: 'system', data: {
      daemon: 'running', redis: 'connected', githubAuth: 'connected', claudeAuth: 'connected', workerCount: 2,
    } }));
    finish({ daemon: 'Stopped' } as SystemStatus);
  });
  expect(result.current.status?.daemon).toBe('Running');
  expect(result.current.status?.workers).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
  expect(state.getSystemStatus).toHaveBeenCalledTimes(1);
});

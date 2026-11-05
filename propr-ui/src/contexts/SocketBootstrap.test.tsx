import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { SocketBootstrap } from './SocketBootstrap';

const socket = vi.hoisted(() => ({ activityReady: false,
  subscribeToActivity: vi.fn(), unsubscribeFromActivity: vi.fn() }));
vi.mock('./useSocket', () => ({ useOptionalSocket: () => socket }));
vi.mock('../api/apiClient', () => ({ getDesktopSocketConfigurationKey: () => 'browser',
  subscribeDesktopConnectionScope: () => () => {} }));
afterEach(() => { socket.activityReady = false; vi.clearAllMocks(); vi.useRealTimers(); });

it('mounts readers once after subscription acknowledgment and retains them through reconnect', () => {
  const read = vi.fn();
  function Reader() { useEffect(() => { read(); }, []); return <div>data</div>; }
  const tree = () => <SocketBootstrap disabled={false} identity="user" fallback="connecting"><Reader /></SocketBootstrap>;
  const view = render(tree());
  expect(read).not.toHaveBeenCalled();
  expect(socket.subscribeToActivity).toHaveBeenCalledOnce();
  socket.activityReady = true;
  view.rerender(tree());
  expect(read).toHaveBeenCalledOnce();
  socket.activityReady = false;
  view.rerender(tree());
  expect(screen.getByText('data')).toBeTruthy();
  socket.activityReady = true;
  view.rerender(tree());
  expect(read).toHaveBeenCalledOnce();
});

it('falls back to HTTP after a bounded wait and does not remount on a late acknowledgment', async () => {
  vi.useFakeTimers();
  const read = vi.fn();
  function Reader() { useEffect(() => { read(); }, []); return <div>data</div>; }
  const tree = () => <SocketBootstrap disabled={false} identity="user" fallback="connecting"><Reader /></SocketBootstrap>;
  const view = render(tree());
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(read).toHaveBeenCalledOnce();
  socket.activityReady = true;
  view.rerender(tree());
  expect(read).toHaveBeenCalledOnce();
});

it('does not delay demo or login rendering', () => {
  render(<SocketBootstrap disabled identity="anonymous" fallback="connecting">login</SocketBootstrap>);
  expect(screen.getByText('login')).toBeTruthy();
  expect(socket.subscribeToActivity).not.toHaveBeenCalled();
});

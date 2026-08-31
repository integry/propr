import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocketProvider } from './SocketProvider';
import { useSocket } from './useSocket';

const runtimeConfigMock = vi.hoisted(() => ({
  getApiBaseUrl: vi.fn(() => ''),
}));

const socketMock = vi.hoisted(() => ({
  disconnect: vi.fn(),
  emit: vi.fn(),
  on: vi.fn(),
  removeAllListeners: vi.fn(),
}));

const ioMock = vi.hoisted(() => vi.fn(() => socketMock));

vi.mock('../config/runtimeConfig', () => runtimeConfigMock);

vi.mock('socket.io-client', () => ({
  io: ioMock,
}));

describe('SocketProvider', () => {
  afterEach(() => {
    cleanup();
    ioMock.mockClear();
    socketMock.disconnect.mockClear();
    socketMock.emit.mockClear();
    socketMock.on.mockClear();
    socketMock.removeAllListeners.mockClear();
    runtimeConfigMock.getApiBaseUrl.mockReturnValue('');
  });

  it('disconnects authenticated identity A before identity B connects and resubscribes', () => {
    const sockets = Array.from({ length: 2 }, () => ({
      disconnect: vi.fn(), emit: vi.fn(), removeAllListeners: vi.fn(),
      on: vi.fn(),
    }));
    ioMock.mockImplementationOnce(() => sockets[0]).mockImplementationOnce(() => sockets[1]);
    const GoalSubscriber = () => {
      const { isConnected, subscribeToGoalUpdates, unsubscribeFromGoalUpdates } = useSocket();
      React.useEffect(() => {
        if (!isConnected) return;
        subscribeToGoalUpdates();
        return unsubscribeFromGoalUpdates;
      }, [isConnected, subscribeToGoalUpdates, unsubscribeFromGoalUpdates]);
      return null;
    };
    const connection = (index: number) => sockets[index].on.mock.calls.find(([name]) => name === 'connect')?.[1] as (() => void);
    const view = render(<SocketProvider key="owner-a" authenticationKey="owner-a"><GoalSubscriber /></SocketProvider>);
    act(() => connection(0)());
    expect(sockets[0].emit).toHaveBeenCalledWith('subscribe:goals');

    view.rerender(<SocketProvider key="owner-b" authenticationKey="owner-b"><GoalSubscriber /></SocketProvider>);
    expect(sockets[0].emit).toHaveBeenCalledWith('unsubscribe:goals');
    expect(sockets[0].removeAllListeners).toHaveBeenCalledOnce();
    expect(sockets[0].disconnect).toHaveBeenCalledOnce();
    expect(ioMock).toHaveBeenCalledTimes(2);
    expect(sockets[0].removeAllListeners.mock.invocationCallOrder[0]).toBeLessThan(ioMock.mock.invocationCallOrder[1]);
    expect(sockets[0].disconnect.mock.invocationCallOrder[0]).toBeLessThan(ioMock.mock.invocationCallOrder[1]);
    act(() => connection(1)());
    expect(sockets[1].emit).toHaveBeenCalledWith('subscribe:goals');
  });

  it('does not connect when disabled for demo mode', () => {
    render(
      <SocketProvider disabled>
        <div>demo</div>
      </SocketProvider>
    );

    expect(ioMock).not.toHaveBeenCalled();
  });

  it('connects when real-time updates are enabled', () => {
    const { unmount } = render(
      <SocketProvider>
        <div>app</div>
      </SocketProvider>
    );

    expect(ioMock).toHaveBeenCalledOnce();
    unmount();
    expect(socketMock.disconnect).toHaveBeenCalledOnce();
  });

  it('connects Socket.IO to the same resolved hosted tunnel origin used by REST calls', () => {
    runtimeConfigMock.getApiBaseUrl.mockReturnValue('https://t-active.propr.dev');
    const { unmount } = render(
      <SocketProvider>
        <div>app</div>
      </SocketProvider>
    );

    expect(ioMock).toHaveBeenCalledWith('https://t-active.propr.dev', expect.objectContaining({
      withCredentials: true,
    }));
    unmount();
  });
});

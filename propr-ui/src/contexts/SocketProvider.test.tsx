import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocketProvider } from './SocketProvider';

const socketMock = vi.hoisted(() => ({
  disconnect: vi.fn(),
  emit: vi.fn(),
  on: vi.fn(),
}));

const ioMock = vi.hoisted(() => vi.fn(() => socketMock));

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
});

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocketProvider } from './SocketProvider';

const socketMock = vi.hoisted(() => ({
  disconnect: vi.fn(),
  emit: vi.fn(),
  on: vi.fn(),
}));

const connectSocketMock = vi.hoisted(() => vi.fn(() => socketMock));

vi.mock('../api/apiClient', () => ({
  proprClient: { connectSocket: connectSocketMock },
}));

describe('SocketProvider', () => {
  afterEach(() => {
    cleanup();
    connectSocketMock.mockClear();
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

    expect(connectSocketMock).not.toHaveBeenCalled();
  });

  it('connects when real-time updates are enabled', () => {
    const { unmount } = render(
      <SocketProvider>
        <div>app</div>
      </SocketProvider>
    );

    expect(connectSocketMock).toHaveBeenCalledOnce();
    unmount();
    expect(socketMock.disconnect).toHaveBeenCalledOnce();
  });

  it('uses the shared client Socket.IO policy', () => {
    const { unmount } = render(
      <SocketProvider>
        <div>app</div>
      </SocketProvider>
    );

    expect(connectSocketMock).toHaveBeenCalledWith(expect.objectContaining({
      withCredentials: true,
    }));
    unmount();
  });
});

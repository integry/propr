import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocketProvider } from './SocketProvider';

const socketHandlers = vi.hoisted(() => new Map<string, (value?: unknown) => void>());
const socketMock = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  emit: vi.fn(),
  on: vi.fn((event: string, handler: (value?: unknown) => void) => { socketHandlers.set(event, handler); }),
}));

const connectSocketMock = vi.hoisted(() => vi.fn(() => socketMock));
const desktopScope = vi.hoisted(() => ({
  bridge: {} as never,
  profileId: 'profile-a',
  connectionGeneration: 3,
}));
const handleDesktopAccessCode = vi.hoisted(() => vi.fn(async () => 'retryable'));

vi.mock('../api/apiClient', () => ({
  proprClient: { connectSocket: connectSocketMock },
  getDesktopConnectionScope: () => desktopScope,
  handleDesktopAccessCode,
}));

describe('SocketProvider', () => {
  afterEach(() => {
    cleanup();
    connectSocketMock.mockClear();
    socketMock.disconnect.mockClear();
    socketMock.connect.mockClear();
    socketMock.emit.mockClear();
    socketMock.on.mockClear();
    socketHandlers.clear();
    handleDesktopAccessCode.mockReset();
    handleDesktopAccessCode.mockResolvedValue('retryable');
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

    expect(connectSocketMock).toHaveBeenCalledWith(expect.not.objectContaining({
      withCredentials: expect.anything(),
    }));
    unmount();
  });

  it('classifies authentication errors against the immutable connection scope', async () => {
    handleDesktopAccessCode.mockResolvedValueOnce('invalidated');
    render(<SocketProvider><div>app</div></SocketProvider>);

    socketHandlers.get('authentication:error')?.({ code: 'INVALID_INSTANCE_TOKEN' });
    await vi.waitFor(() => expect(handleDesktopAccessCode).toHaveBeenCalledWith(
      'INVALID_INSTANCE_TOKEN', desktopScope,
    ));
    expect(socketMock.connect).not.toHaveBeenCalled();
  });

  it('reconnects on authorization changes without treating the token as invalid', async () => {
    handleDesktopAccessCode.mockResolvedValueOnce('authorization-changed');
    render(<SocketProvider><div>app</div></SocketProvider>);

    socketHandlers.get('authentication:error')?.({ code: 'AUTHORIZATION_CHANGED' });
    await vi.waitFor(() => expect(socketMock.connect).toHaveBeenCalledOnce());
    expect(socketMock.disconnect).toHaveBeenCalledOnce();
  });
});

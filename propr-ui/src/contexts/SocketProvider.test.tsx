import { act, cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_TRANSPORT_SCOPE_QUERY,
  DRAFT_UPDATE,
  INDEXING_UPDATE,
  QUEUE_STATS_UPDATE,
  TASK_LIVE_UPDATE,
  TASK_UPDATE,
} from '@propr/shared';
import { SocketProvider } from './SocketProvider';
import { useSocket } from './useSocket';

type Handler = (value?: unknown) => void;
const sockets = vi.hoisted(() => [] as Array<{
  handlers: Map<string, Handler>;
  options: Record<string, unknown>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
}>);
const connectSocketMock = vi.hoisted(() => vi.fn((options: Record<string, unknown>) => {
  const handlers = new Map<string, Handler>();
  const socket = {
    handlers,
    options,
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => { handlers.set(event, handler); }),
    off: vi.fn((event: string, handler?: Handler) => {
      if (!handler || handlers.get(event) === handler) handlers.delete(event);
    }),
  };
  sockets.push(socket);
  return socket;
}));
const scopeListeners = vi.hoisted(() => new Set<() => void>());
const handleDesktopAccessCode = vi.hoisted(() => vi.fn(async () => 'retryable'));
const runtime = vi.hoisted(() => ({ desktop: true }));
const state = vi.hoisted(() => ({
  origin: 'https://a.example.test',
  scope: null as null | { bridge: never; profileId: string; transportScope: string },
}));

vi.mock('../api/apiClient', () => ({
  proprClient: { connectSocket: connectSocketMock },
  getDesktopConnectionScope: () => state.scope,
  getDesktopSocketConfigurationKey: () =>
    `${runtime.desktop ? 'desktop' : 'browser'}\u0000${state.origin}\u0000${state.scope?.profileId ?? ''}\u0000${state.scope?.transportScope ?? ''}`,
  subscribeDesktopConnectionScope: (listener: () => void) => {
    scopeListeners.add(listener);
    return () => scopeListeners.delete(listener);
  },
  handleDesktopAccessCode,
}));
vi.mock('../config/runtimeMode', () => ({ isDesktopRuntime: () => runtime.desktop }));

const scope = (profileId: string, transportScope: string) => ({
  bridge: {} as never,
  profileId,
  transportScope,
});
const publish = (next: typeof state.scope, origin = state.origin) => {
  act(() => {
    state.scope = next;
    state.origin = origin;
    scopeListeners.forEach(listener => listener());
  });
};

describe('SocketProvider', () => {
  afterEach(() => {
    cleanup();
    sockets.splice(0);
    connectSocketMock.mockClear();
    scopeListeners.clear();
    handleDesktopAccessCode.mockReset();
    handleDesktopAccessCode.mockResolvedValue('retryable');
    runtime.desktop = true;
    state.origin = 'https://a.example.test';
    state.scope = null;
  });

  it('does not connect when disabled or when desktop has no activation scope', () => {
    const { rerender } = render(<SocketProvider disabled><div>demo</div></SocketProvider>);
    rerender(<SocketProvider><div>desktop</div></SocketProvider>);

    expect(connectSocketMock).not.toHaveBeenCalled();
  });

  it('constructs and explicitly connects once when bootstrap enables a published activation', () => {
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    const { rerender } = render(<SocketProvider disabled><div>loading</div></SocketProvider>);
    expect(connectSocketMock).not.toHaveBeenCalled();

    rerender(<SocketProvider><div>ready</div></SocketProvider>);

    expect(connectSocketMock).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].connect).toHaveBeenCalledOnce();
  });

  it('creates one force-new scoped Manager on null-to-A activation', () => {
    render(<SocketProvider><div>app</div></SocketProvider>);
    publish(scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA'));

    expect(connectSocketMock).toHaveBeenCalledOnce();
    expect(connectSocketMock).toHaveBeenCalledWith(expect.objectContaining({
      autoConnect: false,
      forceNew: true,
      withCredentials: false,
      query: { proprDesktopTransportScope: 'AAAAAAAAAAAAAAAAAAAAAA' },
    }));
    expect(sockets[0].connect).toHaveBeenCalledOnce();
    expect(sockets[0].on.mock.invocationCallOrder.at(-1))
      .toBeLessThan(sockets[0].connect.mock.invocationCallOrder[0]);
    const options = sockets[0].options;
    const query = options.query as Record<string, unknown>;
    expect(Object.keys(query)).toEqual([DESKTOP_TRANSPORT_SCOPE_QUERY]);
    expect(query[DESKTOP_TRANSPORT_SCOPE_QUERY]).toBe('AAAAAAAAAAAAAAAAAAAAAA');
    expect(Object.prototype.hasOwnProperty.call(options, 'auth')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(options, 'extraHeaders')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(options, 'bearer')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(options, 'authorization')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(options, 'cookie')).toBe(false);
    expect(JSON.stringify(options)).not.toMatch(/bearer|authorization|cookie/i);
  });

  it.each([
    ['scope rotation', scope('profile-a', 'BBBBBBBBBBBBBBBBBBBBBB')],
    ['same-origin A-to-B', scope('profile-b', 'BBBBBBBBBBBBBBBBBBBBBB')],
  ])('fully detaches A before creating a distinct Manager for %s', (_name, nextScope) => {
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    render(<SocketProvider><div>app</div></SocketProvider>);
    const socketA = sockets[0];

    publish(nextScope);

    expect(sockets).toHaveLength(2);
    expect(socketA.disconnect).toHaveBeenCalledOnce();
    expect(socketA.off).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(socketA.off).toHaveBeenCalledWith('authentication:error', expect.any(Function));
    expect(socketA.disconnect.mock.invocationCallOrder[0])
      .toBeLessThan(connectSocketMock.mock.invocationCallOrder[1]);
    expect(sockets[1]).not.toBe(socketA);
  });

  it('reports a replacement Manager as disconnected until its own connect event', () => {
    const connectedStates: boolean[] = [];
    const ConnectionState = () => {
      connectedStates.push(useSocket().isConnected);
      return null;
    };
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    render(<SocketProvider><ConnectionState /></SocketProvider>);

    act(() => { sockets[0].handlers.get('connect')?.(); });
    expect(connectedStates.at(-1)).toBe(true);

    publish(scope('profile-b', 'BBBBBBBBBBBBBBBBBBBBBB'));
    expect(connectedStates.at(-1)).toBe(false);
    act(() => { sockets[1].handlers.get('connect_error')?.(new Error('not connected')); });
    expect(connectedStates.at(-1)).toBe(false);
    act(() => { sockets[1].handlers.get('connect')?.(); });
    expect(connectedStates.at(-1)).toBe(true);
  });

  it('rotates the Manager when the effective API origin changes', () => {
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    render(<SocketProvider><div>app</div></SocketProvider>);
    const socketA = sockets[0];

    publish(state.scope, 'https://b.example.test');

    expect(sockets).toHaveLength(2);
    expect(socketA.disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects on deactivate and creates no replacement', () => {
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    render(<SocketProvider><div>app</div></SocketProvider>);
    const socketA = sockets[0];

    publish(null);

    expect(socketA.disconnect).toHaveBeenCalledOnce();
    expect(connectSocketMock).toHaveBeenCalledOnce();
  });

  it('keeps the hosted browser cookie socket without a desktop marker', () => {
    runtime.desktop = false;
    render(<SocketProvider><div>app</div></SocketProvider>);

    expect(connectSocketMock).toHaveBeenCalledOnce();
    expect(connectSocketMock).toHaveBeenCalledWith(expect.objectContaining({ forceNew: true }));
    expect(connectSocketMock).toHaveBeenCalledWith(expect.not.objectContaining({ query: expect.anything() }));
  });

  it('classifies authentication errors against the immutable activation scope', async () => {
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    handleDesktopAccessCode.mockResolvedValueOnce('invalidated');
    render(<SocketProvider><div>app</div></SocketProvider>);

    sockets[0].handlers.get('authentication:error')?.({ code: 'INVALID_INSTANCE_TOKEN' });
    await vi.waitFor(() => expect(handleDesktopAccessCode).toHaveBeenCalledWith(
      'INVALID_INSTANCE_TOKEN', state.scope,
    ));
    expect(sockets[0].connect).toHaveBeenCalledOnce();
  });

  it('reconnects the current Manager when authorization changes without invalidating its token', async () => {
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    handleDesktopAccessCode.mockResolvedValueOnce('authorization-changed');
    render(<SocketProvider><div>app</div></SocketProvider>);
    const socketA = sockets[0];

    socketA.handlers.get('authentication:error')?.({ code: 'AUTHORIZATION_CHANGED' });

    await vi.waitFor(() => expect(socketA.connect).toHaveBeenCalledTimes(2));
    expect(handleDesktopAccessCode).toHaveBeenCalledWith('AUTHORIZATION_CHANGED', state.scope);
    expect(socketA.disconnect).toHaveBeenCalledOnce();
  });

  it('never reconnects a stale same-origin Manager after deferred authorization work resolves', async () => {
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    let resolveClassification!: (value: 'authorization-changed') => void;
    handleDesktopAccessCode.mockReturnValueOnce(new Promise(resolve => { resolveClassification = resolve; }));
    render(<SocketProvider><div>app</div></SocketProvider>);
    const socketA = sockets[0];
    const staleAuthenticationHandler = socketA.handlers.get('authentication:error');

    staleAuthenticationHandler?.({ code: 'AUTHORIZATION_CHANGED' });
    await vi.waitFor(() => expect(handleDesktopAccessCode).toHaveBeenCalledWith(
      'AUTHORIZATION_CHANGED', state.scope,
    ));
    publish(scope('profile-b', 'BBBBBBBBBBBBBBBBBBBBBB'));
    const socketB = sockets[1];
    resolveClassification('authorization-changed');
    await Promise.resolve();

    expect(socketA.connect).toHaveBeenCalledOnce();
    expect(socketA.disconnect).toHaveBeenCalledOnce();
    expect(socketA.off).toHaveBeenCalledWith('authentication:error', staleAuthenticationHandler);
    expect(socketA.handlers.size).toBe(0);
    expect(socketB.disconnect).not.toHaveBeenCalled();
    expect(socketB.connect).toHaveBeenCalledOnce();
  });

  it('drops every application event dispatched by a stale socket scope', () => {
    const received = {
      task: vi.fn(),
      draft: vi.fn(),
      indexing: vi.fn(),
      queue: vi.fn(),
      live: vi.fn(),
    };
    const Subscriber = () => {
      const value = useSocket();
      useEffect(() => {
        const unsubscribe = [
          value.onTaskUpdate(received.task),
          value.onDraftUpdate(received.draft),
          value.onIndexingUpdate(received.indexing),
          value.onQueueStatsUpdate(received.queue),
          value.onTaskLiveUpdate(received.live),
        ];
        return () => unsubscribe.forEach(remove => remove());
      }, [value]);
      return null;
    };
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    render(<SocketProvider><Subscriber /></SocketProvider>);
    const staleHandlers = new Map(sockets[0].handlers);

    publish(scope('profile-b', 'BBBBBBBBBBBBBBBBBBBBBB'));
    act(() => {
      staleHandlers.get(TASK_UPDATE)?.({ id: 'stale-task' });
      staleHandlers.get(DRAFT_UPDATE)?.({ id: 'stale-draft' });
      staleHandlers.get(INDEXING_UPDATE)?.({ id: 'stale-indexing' });
      staleHandlers.get(QUEUE_STATS_UPDATE)?.({ id: 'stale-queue' });
      staleHandlers.get(TASK_LIVE_UPDATE)?.({ id: 'stale-live' });
    });

    Object.values(received).forEach(callback => expect(callback).not.toHaveBeenCalled());

    act(() => {
      sockets[1].handlers.get(TASK_UPDATE)?.({ id: 'current-task' });
      sockets[1].handlers.get(DRAFT_UPDATE)?.({ id: 'current-draft' });
      sockets[1].handlers.get(INDEXING_UPDATE)?.({ id: 'current-indexing' });
      sockets[1].handlers.get(QUEUE_STATS_UPDATE)?.({ id: 'current-queue' });
      sockets[1].handlers.get(TASK_LIVE_UPDATE)?.({ id: 'current-live' });
    });
    Object.values(received).forEach(callback => expect(callback).toHaveBeenCalledOnce());
  });

  it('fully detaches listeners and disconnects on unmount', () => {
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    const { unmount } = render(<SocketProvider><div>app</div></SocketProvider>);
    const socketA = sockets[0];

    unmount();

    expect(socketA.disconnect).toHaveBeenCalledOnce();
    expect(socketA.handlers.size).toBe(0);
    expect(scopeListeners.size).toBe(0);
  });
});

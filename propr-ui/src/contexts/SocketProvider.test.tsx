import { useEffect } from 'react';
import {
  ACTIVITY_UPDATE,
  GOAL_UPDATE,
  NOTIFICATION_UPDATE,
  TASK_LIVE_UPDATE,
  TASK_UPDATE,
  USAGE_UPDATE,
} from '@propr/shared';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocketProvider } from './SocketProvider';
import { useSocket } from './useSocket';

type Handler = (value?: unknown) => void;
const sockets = vi.hoisted(() => [] as Array<{
  handlers: Map<string, Handler>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
}>);
const connectSocketMock = vi.hoisted(() => vi.fn(() => {
  const handlers = new Map<string, Handler>();
  const socket = {
    handlers,
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
  getProprClient: () => ({ connectSocket: connectSocketMock }),
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

  it('creates one force-new scoped Manager on null-to-A activation', () => {
    render(<SocketProvider><div>app</div></SocketProvider>);
    publish(scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA'));

    expect(connectSocketMock).toHaveBeenCalledOnce();
    expect(connectSocketMock).toHaveBeenCalledWith(expect.objectContaining({
      forceNew: true,
      auth: { proprDesktopTransportScope: 'AAAAAAAAAAAAAAAAAAAAAA' },
      query: { proprDesktopTransportScope: 'AAAAAAAAAAAAAAAAAAAAAA' },
    }));
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
    expect(connectSocketMock).toHaveBeenCalledWith(expect.not.objectContaining({ auth: expect.anything() }));
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
    expect(sockets[0].connect).not.toHaveBeenCalled();
  });

  it('reconnects the current Manager when authorization changes without invalidating its token', async () => {
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    handleDesktopAccessCode.mockResolvedValueOnce('authorization-changed');
    render(<SocketProvider><div>app</div></SocketProvider>);
    const socketA = sockets[0];

    socketA.handlers.get('authentication:error')?.({ code: 'AUTHORIZATION_CHANGED' });

    await vi.waitFor(() => expect(socketA.connect).toHaveBeenCalledOnce());
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

    expect(socketA.connect).not.toHaveBeenCalled();
    expect(socketA.disconnect).toHaveBeenCalledOnce();
    expect(socketA.off).toHaveBeenCalledWith('authentication:error', staleAuthenticationHandler);
    expect(socketA.handlers.size).toBe(0);
    expect(socketB.disconnect).not.toHaveBeenCalled();
    expect(socketB.connect).not.toHaveBeenCalled();
  });

  it('drops application events delivered by an old desktop scope', () => {
    const observed = vi.fn();
    const Observer = () => {
      const { onTaskUpdate } = useSocket();
      useEffect(() => onTaskUpdate(observed), [onTaskUpdate]);
      return null;
    };
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    render(<SocketProvider><Observer /></SocketProvider>);
    const staleTaskHandler = sockets[0].handlers.get(TASK_UPDATE);

    publish(scope('profile-b', 'BBBBBBBBBBBBBBBBBBBBBB'));
    act(() => { staleTaskHandler?.({ eventType: TASK_UPDATE } as never); });

    expect(observed).not.toHaveBeenCalled();
    act(() => { sockets[1].handlers.get(TASK_UPDATE)?.({ eventType: TASK_UPDATE } as never); });
    expect(observed).toHaveBeenCalledOnce();
  });

  it('delivers live events without logging their potentially large payload', () => {
    const observed = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const Observer = () => {
      const { onTaskLiveUpdate } = useSocket();
      useEffect(() => onTaskLiveUpdate(observed), [onTaskLiveUpdate]);
      return null;
    };
    const payload = {
      eventType: TASK_LIVE_UPDATE,
      taskId: 'task-1',
      events: [{ type: 'tool_result', result: 'large output' }],
      todos: [],
      currentTask: null,
      tokenUsage: null,
      timestamp: '2026-09-14T08:45:00.000Z',
    };
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    render(<SocketProvider><Observer /></SocketProvider>);

    act(() => { sockets[0].handlers.get(TASK_LIVE_UPDATE)?.(payload); });

    expect(observed).toHaveBeenCalledWith(payload);
    expect(log.mock.calls.find(call => String(call[0]).startsWith(
      '[SocketContext] Received task live update:',
    ))).toEqual(['[SocketContext] Received task live update: 1 event(s)']);
    log.mockRestore();
  });

  it('reference-counts the activity room and rejoins it after a reconnect', () => {
    const ActivityConsumer = () => {
      const { subscribeToActivity, unsubscribeFromActivity } = useSocket();
      useEffect(() => {
        subscribeToActivity();
        return unsubscribeFromActivity;
      }, [subscribeToActivity, unsubscribeFromActivity]);
      return null;
    };
    const emitted = (event: string) =>
      sockets[0].emit.mock.calls.filter(call => call[0] === event).length;
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    const { rerender } = render(
      <SocketProvider><ActivityConsumer /><ActivityConsumer /></SocketProvider>,
    );

    act(() => { sockets[0].handlers.get('connect')?.(); });
    // Two subscribers, one join: a duplicate would double every frame's cost.
    expect(emitted('subscribe:activity')).toBe(1);

    rerender(<SocketProvider><ActivityConsumer /></SocketProvider>);
    // The first consumer to leave must not unsubscribe the one still watching.
    expect(emitted('unsubscribe:activity')).toBe(0);

    act(() => { sockets[0].handlers.get('disconnect')?.('transport close'); });
    act(() => { sockets[0].handlers.get('connect')?.(); });
    // Room membership does not survive a reconnect, so it is re-emitted.
    expect(emitted('subscribe:activity')).toBe(2);

    rerender(<SocketProvider><div>no consumers</div></SocketProvider>);
    expect(emitted('unsubscribe:activity')).toBe(1);
    expect(emitted('subscribe:activity')).toBe(2);
    // Room bookkeeping must never cost a connection: a surface whose identity
    // changed per render would rebuild the Manager on every one of them.
    expect(connectSocketMock).toHaveBeenCalledOnce();
  });

  it('delivers activity, goal, notification and usage events without logging their payloads', () => {
    const observed = {
      activity: vi.fn(),
      goal: vi.fn(),
      notification: vi.fn(),
      usage: vi.fn(),
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const Observer = () => {
      const { onActivityUpdate, onGoalUpdate, onNotificationUpdate, onUsageUpdate } = useSocket();
      useEffect(() => onActivityUpdate(observed.activity), [onActivityUpdate]);
      useEffect(() => onGoalUpdate(observed.goal), [onGoalUpdate]);
      useEffect(() => onNotificationUpdate(observed.notification), [onNotificationUpdate]);
      useEffect(() => onUsageUpdate(observed.usage), [onUsageUpdate]);
      return null;
    };
    const activity = {
      eventType: ACTIVITY_UPDATE,
      domain: 'task',
      change: 'completed',
      entityId: 'task-1',
      repository: 'acme/app',
      terminal: true,
      occurredAt: '2026-09-26T10:00:00.000Z',
    };
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    render(<SocketProvider><Observer /></SocketProvider>);

    act(() => { sockets[0].handlers.get(ACTIVITY_UPDATE)?.(activity); });
    act(() => { sockets[0].handlers.get(GOAL_UPDATE)?.({ eventType: GOAL_UPDATE }); });
    act(() => { sockets[0].handlers.get(NOTIFICATION_UPDATE)?.({ eventType: NOTIFICATION_UPDATE }); });
    act(() => { sockets[0].handlers.get(USAGE_UPDATE)?.({ eventType: USAGE_UPDATE }); });

    expect(observed.activity).toHaveBeenCalledWith(activity);
    expect(observed.goal).toHaveBeenCalledOnce();
    expect(observed.notification).toHaveBeenCalledOnce();
    expect(observed.usage).toHaveBeenCalledOnce();
    // These frames are frequent and name repositories; none of them is logged.
    expect(log.mock.calls.filter(call => String(call[0]).includes('activity'))).toEqual([]);
    log.mockRestore();
  });

  it('drops activity events delivered by an old desktop scope', () => {
    const observed = vi.fn();
    const Observer = () => {
      const { onActivityUpdate } = useSocket();
      useEffect(() => onActivityUpdate(observed), [onActivityUpdate]);
      return null;
    };
    state.scope = scope('profile-a', 'AAAAAAAAAAAAAAAAAAAAAA');
    render(<SocketProvider><Observer /></SocketProvider>);
    const staleActivityHandler = sockets[0].handlers.get(ACTIVITY_UPDATE);

    publish(scope('profile-b', 'BBBBBBBBBBBBBBBBBBBBBB'));
    act(() => { staleActivityHandler?.({ eventType: ACTIVITY_UPDATE } as never); });

    expect(observed).not.toHaveBeenCalled();
    act(() => { sockets[1].handlers.get(ACTIVITY_UPDATE)?.({ eventType: ACTIVITY_UPDATE } as never); });
    expect(observed).toHaveBeenCalledOnce();
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

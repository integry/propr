import { useCallback, useMemo, useRef } from 'react';
import type { Socket } from '@propr/client';
import {
  ACTIVITY_UPDATE,
  GOAL_UPDATE,
  NOTIFICATION_UPDATE,
  USAGE_UPDATE,
  type ActivityUpdatePayload,
  type GoalUpdatePayload,
  type NotificationUpdatePayload,
  type UsageUpdatePayload,
} from '@propr/shared';
import type { SocketContextValue } from './SocketContext';

type Listener<T> = (payload: T) => void;

export interface ActivitySocketSurface {
  /**
   * Installs the four activity-surface listeners on a freshly created socket
   * and returns the matching detach, so the provider's cleanup removes exactly
   * what it added and leaves no handler behind on a superseded Manager.
   */
  attach: (socket: Socket, isCurrentScope: () => boolean) => () => void;
  /** Called from the socket's own connect handler. */
  handleConnected: (socket: Socket) => void;
  /** Called whenever the socket stops being usable: disconnect, error, teardown. */
  handleDisconnected: () => void;
  /** The part of the context value this surface owns. */
  subscriptions: Pick<
    SocketContextValue,
    | 'subscribeToActivity'
    | 'unsubscribeFromActivity'
    | 'onActivityReady'
    | 'onActivityUpdate'
    | 'onGoalUpdate'
    | 'onNotificationUpdate'
    | 'onUsageUpdate'
  >;
}

const useRegistry = <T,>() => {
  const listeners = useRef(new Set<Listener<T>>());
  const subscribe = useCallback((callback: Listener<T>) => {
    listeners.current.add(callback);
    return () => { listeners.current.delete(callback); };
  }, []);
  // Memoized because the provider's socket effect depends on this surface: a
  // fresh object per render would tear down and rebuild the connection on
  // every render.
  return useMemo(() => ({ listeners, subscribe }), [subscribe]);
};

/**
 * The instance-wide activity push surface: `activity:update`, `goal:update`,
 * `notification:update` and `usage:update`, plus the reference-counted room
 * membership they arrive through.
 *
 * It lives beside the provider rather than inside it because the room is the
 * only subscription with shared ownership - several independent components
 * want instance-wide activity at once, Socket.IO rooms are not
 * reference-counted, and the count has to outlive all of them.
 */
export function useActivitySocketSurface(): ActivitySocketSurface {
  const ready = useRegistry<void>();
  const activity = useRegistry<ActivityUpdatePayload>();
  const goal = useRegistry<GoalUpdatePayload>();
  const notification = useRegistry<NotificationUpdatePayload>();
  const usage = useRegistry<UsageUpdatePayload>();
  /**
   * How many components currently want instance-wide activity. Without the
   * count, the first consumer to unmount would silently unsubscribe the
   * others. It deliberately survives a socket replacement, because the
   * consumers do: the replacement rejoins the room on its connect.
   */
  const subscriberCount = useRef(0);
  /**
   * The socket and its connection state are mirrored in refs so the subscribe
   * helpers keep a stable identity: a helper that changed on every connect
   * would re-run every consumer's subscription effect and churn the room.
   */
  const socketRef = useRef<Socket | null>(null);
  const connectedRef = useRef(false);

  const attach = useCallback((socket: Socket, isCurrentScope: () => boolean) => {
    // The same scope guard as the existing events: a frame that arrived for a
    // superseded desktop activation scope must be discarded rather than
    // triggering a fetch against the profile that replaced it.
    //
    // Payloads are never logged. These frames are far more frequent than the
    // lifecycle ones, they name repositories, and per-frame console work
    // competes with rendering on the main thread - the same reason
    // `task:live:update` logs only a count.
    const fanOut = <T,>(registry: { listeners: { current: Set<Listener<T>> } }) => (payload: T) => {
      if (!isCurrentScope()) return;
      registry.listeners.current.forEach(callback => callback(payload));
    };
    const activityReady = fanOut(ready);
    const activityUpdated = fanOut(activity);
    const goalUpdated = fanOut(goal);
    const notificationUpdated = fanOut(notification);
    const usageUpdated = fanOut(usage);

    socket.on('activity:ready', activityReady);
    socket.on(ACTIVITY_UPDATE, activityUpdated);
    socket.on(GOAL_UPDATE, goalUpdated);
    socket.on(NOTIFICATION_UPDATE, notificationUpdated);
    socket.on(USAGE_UPDATE, usageUpdated);

    return () => {
      socket.off('activity:ready', activityReady);
      socket.off(ACTIVITY_UPDATE, activityUpdated);
      socket.off(GOAL_UPDATE, goalUpdated);
      socket.off(NOTIFICATION_UPDATE, notificationUpdated);
      socket.off(USAGE_UPDATE, usageUpdated);
    };
  }, [activity, goal, notification, usage, ready]);

  const handleConnected = useCallback((socket: Socket) => {
    socketRef.current = socket;
    connectedRef.current = true;
    // Socket.IO room membership does not survive a reconnect, so a socket that
    // still has consumers must rejoin or it would go quiet and leave every one
    // of them on the disconnected polling fallback forever.
    if (subscriberCount.current > 0) socket.emit('subscribe:activity');
  }, []);

  const handleDisconnected = useCallback(() => {
    connectedRef.current = false;
    socketRef.current = null;
  }, []);

  const subscribeToActivity = useCallback(() => {
    subscriberCount.current += 1;
    // Emit only on the 0 -> 1 transition: a second subscriber must not send a
    // duplicate join, and the count is what makes the last leave correct. A
    // subscriber that arrives before the socket connects is picked up by the
    // rejoin in `handleConnected`.
    if (subscriberCount.current === 1 && connectedRef.current) {
      socketRef.current?.emit('subscribe:activity');
      console.log('[SocketContext] Subscribed to activity');
    }
  }, []);

  const unsubscribeFromActivity = useCallback(() => {
    if (subscriberCount.current === 0) return;
    subscriberCount.current -= 1;
    if (subscriberCount.current === 0 && connectedRef.current) {
      socketRef.current?.emit('unsubscribe:activity');
      console.log('[SocketContext] Unsubscribed from activity');
    }
  }, []);

  return useMemo(() => ({
    attach,
    handleConnected,
    handleDisconnected,
    subscriptions: {
      subscribeToActivity,
      unsubscribeFromActivity,
      onActivityReady: ready.subscribe,
      onActivityUpdate: activity.subscribe,
      onGoalUpdate: goal.subscribe,
      onNotificationUpdate: notification.subscribe,
      onUsageUpdate: usage.subscribe,
    },
  }), [
    activity.subscribe,
    ready.subscribe,
    attach,
    goal.subscribe,
    handleConnected,
    handleDisconnected,
    notification.subscribe,
    subscribeToActivity,
    unsubscribeFromActivity,
    usage.subscribe,
  ]);
}

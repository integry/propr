import { useContext, useEffect } from 'react';
import { SocketContext } from '../contexts/SocketContext';
import { matchesInterest, type LiveResourceInterest } from './useLiveResource';
import { useLiveRefreshScheduler } from './useLiveRefreshScheduler';

/** Push scheduling for projections that already own state and mutation ordering. */
export function useLiveInvalidation({ refresh, scopeKey, interest, disabled = false, fallbackPollMs = 30_000 }: {
  refresh: () => unknown | Promise<unknown>;
  scopeKey: string;
  interest: LiveResourceInterest;
  disabled?: boolean;
  fallbackPollMs?: number;
}) {
  const socket = useContext(SocketContext);
  const schedule = useLiveRefreshScheduler({
    isConnected: socket?.isConnected ?? false,
    refresh: () => disabled ? undefined : refresh(),
    scopeKey,
    fallbackPollMs,
  });
  const { refreshNow } = schedule;
  useEffect(() => {
    if (!disabled) void refreshNow().catch(() => undefined);
  }, [disabled, scopeKey, refreshNow]);
  const { subscribeToActivity, unsubscribeFromActivity, onActivityReady, onActivityUpdate, onGoalUpdate,
    onNotificationUpdate, onUsageUpdate } = socket ?? {};
  const interestKey = JSON.stringify(interest);
  useEffect(() => {
    if (disabled) return;
    const filter = JSON.parse(interestKey) as LiveResourceInterest;
    const cleanups = [onActivityReady?.(() => schedule()), onActivityUpdate?.(payload => {
      if (matchesInterest(payload, filter)) schedule();
    })];
    if (filter.goals) cleanups.push(onGoalUpdate?.(() => schedule()));
    if (filter.notifications) cleanups.push(onNotificationUpdate?.(() => schedule()));
    if (filter.usage) cleanups.push(onUsageUpdate?.(() => schedule()));
    subscribeToActivity?.();
    return () => {
      cleanups.forEach(cleanup => cleanup?.());
      unsubscribeFromActivity?.();
    };
  }, [disabled, interestKey, subscribeToActivity, unsubscribeFromActivity, onActivityReady, onActivityUpdate,
    onGoalUpdate, onNotificationUpdate, onUsageUpdate, schedule]);
  return schedule;
}

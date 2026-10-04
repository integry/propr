import { useEffect } from 'react';
import { useOptionalSocket } from '../contexts/useSocket';
import { matchesInterest, type LiveResourceInterest } from './useLiveResource';
import { CONNECTED_RECONCILE_MS, useLiveRefreshScheduler } from './useLiveRefreshScheduler';

/** Push scheduling for projections that already own state and mutation ordering. */
export function useLiveInvalidation({ refresh, scopeKey, interest, disabled = false, fallbackPollMs = 30_000, pushOnly = false }: {
  refresh: () => unknown | Promise<unknown>;
  scopeKey: string;
  interest: LiveResourceInterest;
  disabled?: boolean;
  fallbackPollMs?: number;
  pushOnly?: boolean;
}) {
  // Through the same accessor every other surface uses, so a shell provider
  // mounted without a socket takes the disconnected contract and a consumer
  // cannot end up reading a different socket than the rest of the tree.
  const socket = useOptionalSocket();
  const schedule = useLiveRefreshScheduler({
    isConnected: socket?.isConnected ?? false,
    refresh: () => disabled ? undefined : refresh(),
    scopeKey,
    fallbackPollMs,
    connectedPollMs: disabled || pushOnly ? undefined : CONNECTED_RECONCILE_MS,
  });
  const { refreshNow } = schedule;
  useEffect(() => {
    if (!disabled) void refreshNow().catch(() => undefined);
  }, [disabled, scopeKey, refreshNow]);
  const { subscribeToActivity, unsubscribeFromActivity, onActivityReady, onActivityUpdate, onGoalUpdate,
    onNotificationUpdate, onUsageUpdate } = socket ?? {};
  const interestKey = JSON.stringify(interest);
  useEffect(() => {
    if (disabled || pushOnly) return;
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
  }, [disabled, pushOnly, interestKey, subscribeToActivity, unsubscribeFromActivity, onActivityReady, onActivityUpdate,
    onGoalUpdate, onNotificationUpdate, onUsageUpdate, schedule]);
  return schedule;
}

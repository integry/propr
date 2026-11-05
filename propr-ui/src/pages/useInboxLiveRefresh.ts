import { useEffect } from 'react';
import { useSocket } from '../contexts/useSocket';
import {
  CONNECTED_RECONCILE_MS,
  useLiveRefreshScheduler,
  type LiveRefreshScheduler,
} from '../hooks/useLiveRefreshScheduler';

/** Fallback cadence, armed by the scheduler only while the socket is down. */
const INBOX_FALLBACK_POLL_MS = 60_000;

/**
 * The Inbox's single coalescing re-read, plus its activity subscription.
 *
 * Kept out of `useInboxNotifications` so that hook stays about the list itself:
 * this owns the first read, coalescing of a burst, and the one reconcile a
 * freshly authorized activity room owes a client whose reads may have raced it.
 * When the re-read happens is decided by `useInboxRefreshTriggers`, which calls
 * the scheduler this returns.
 */
export function useInboxLiveRefresh(refresh: () => unknown): LiveRefreshScheduler {
  const { isConnected, subscribeToActivity, unsubscribeFromActivity, onActivityReady } = useSocket();
  const schedule = useLiveRefreshScheduler({
    refresh,
    scopeKey: 'inbox',
    isConnected,
    fallbackPollMs: INBOX_FALLBACK_POLL_MS,
    // A read or dismissal committed in another session is published best
    // effort: if that publication is lost the socket stays healthy and nothing
    // else would ever tell this Inbox, so it reconciles on the same slow
    // cadence every other push-driven surface uses.
    connectedPollMs: CONNECTED_RECONCILE_MS,
  });
  const { refreshNow } = schedule;
  useEffect(() => { void refreshNow(); }, [refreshNow]);
  useEffect(() => {
    const unsubscribeReady = onActivityReady?.(() => schedule());
    subscribeToActivity?.();
    return () => { unsubscribeReady?.(); unsubscribeFromActivity?.(); };
  }, [onActivityReady, subscribeToActivity, unsubscribeFromActivity, schedule]);
  return schedule;
}

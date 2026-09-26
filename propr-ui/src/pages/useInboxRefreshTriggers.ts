import { useCallback, useEffect, useRef } from 'react';
import type { NotificationUpdatePayload } from '@propr/shared';
import { useSocket } from '../contexts/useSocket';

/** Fallback cadence, armed only while the websocket is unavailable. */
const DISCONNECTED_FALLBACK_INTERVAL_MS = 60_000;
/**
 * How long a notification id stays marked as mutated by this client.
 *
 * Long enough to cover the server's echo of our own dismissal or read, short
 * enough that a genuinely later change to the same notification - from another
 * tab, or a server-side cleanup - still reconciles.
 */
const LOCAL_MUTATION_ECHO_MS = 10_000;

export interface InboxRefreshTriggerOptions {
  /** Whether reconciling is worth doing now: visible, online, and not clearing. */
  canReconcile: () => boolean;
  /** Silent reconcile of the newest page. */
  reconcile: () => void;
}

export interface InboxRefreshTriggers {
  /**
   * Records that this client mutated a notification itself.
   *
   * The server echoes our own dismissal or read back, and we already know the
   * outcome for those ids: re-reading on the echo can resurrect a card the user
   * dismissed, or clobber a mutation that is still in flight.
   */
  markLocallyMutated: (eventId: string) => void;
}

/**
 * Decides *when* the Inbox re-reads, leaving the list hook to decide how.
 *
 * The Inbox is told about changes rather than polling for them: a notification
 * created by a producer, dismissed in another tab, or swept by a server-side
 * cleanup arrives as `notification:update`. Polling remains only as the
 * fallback for a client whose websocket is unavailable.
 */
export function useInboxRefreshTriggers({
  canReconcile,
  reconcile,
}: InboxRefreshTriggerOptions): InboxRefreshTriggers {
  const { isConnected, onNotificationUpdate } = useSocket();
  const previousConnectedRef = useRef<boolean | null>(null);
  const locallyMutatedRef = useRef(new Set<string>());

  const markLocallyMutated = useCallback((eventId: string) => {
    locallyMutatedRef.current.add(eventId);
    // Forgotten after a short window so the set cannot grow without bound and
    // a later genuine change to the same notification is not ignored forever.
    window.setTimeout(() => { locallyMutatedRef.current.delete(eventId); }, LOCAL_MUTATION_ECHO_MS);
  }, []);

  const reconcileWhenWorthwhile = useCallback(() => {
    if (canReconcile()) reconcile();
  }, [canReconcile, reconcile]);

  useEffect(() => {
    // One reconcile for everything that changed while the tab was away.
    window.addEventListener('focus', reconcileWhenWorthwhile);
    document.addEventListener('visibilitychange', reconcileWhenWorthwhile);
    return () => {
      window.removeEventListener('focus', reconcileWhenWorthwhile);
      document.removeEventListener('visibilitychange', reconcileWhenWorthwhile);
    };
  }, [reconcileWhenWorthwhile]);

  useEffect(() => {
    if (!isConnected) return;
    return onNotificationUpdate((payload: NotificationUpdatePayload) => {
      // A bulk clear has no single subject, so it always reconciles the list.
      if (payload.change !== 'dismissed_all'
        && payload.eventId
        && locallyMutatedRef.current.has(payload.eventId)) return;
      // A hidden tab does no work; the visibility handler above reconciles on
      // return, so nothing is lost by skipping here.
      reconcileWhenWorthwhile();
    });
  }, [isConnected, onNotificationUpdate, reconcileWhenWorthwhile]);

  useEffect(() => {
    // Reconnect reconciliation: the socket was down, so the list may have moved
    // on. Exactly one catch-up read per transition; the initial load covers a
    // tab that was already connected when it mounted.
    const previous = previousConnectedRef.current;
    previousConnectedRef.current = isConnected;
    if (previous === false && isConnected) reconcileWhenWorthwhile();
  }, [isConnected, reconcileWhenWorthwhile]);

  useEffect(() => {
    // Fallback polling only while the websocket is unavailable, so a client
    // without a socket degrades instead of going stale.
    if (isConnected) return;
    const interval = window.setInterval(reconcileWhenWorthwhile, DISCONNECTED_FALLBACK_INTERVAL_MS);
    return () => { window.clearInterval(interval); };
  }, [isConnected, reconcileWhenWorthwhile]);

  return { markLocallyMutated };
}

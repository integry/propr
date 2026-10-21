import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useListSearchParams } from '../components/TaskList/hooks';

/** Tailwind `xl`: wide enough to show the queue and a triage verdict side by side. */
export const INBOX_SPLIT_QUERY = '(min-width: 1280px)';

const matchesSplit = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(INBOX_SPLIT_QUERY).matches;

export interface InboxSelection {
  /** The notification open beside the queue, from `?notification=`. */
  selectedId: string | null;
  /** Opens a notification beside the queue, or closes the pane with `null`. Keeps every other query param. */
  select: (notificationId: string | null) => void;
  /** Whether the viewport is wide enough for the queue and a verdict side by side. */
  isSplitViewport: boolean;
}

/**
 * The notification selected on `/inbox`, kept in the URL so a reload or a
 * shared link restores it. Selection replaces the history entry, so stepping
 * through the queue with j/k does not fill the back button.
 */
export function useInboxSelection(): InboxSelection {
  const [searchParams, setSearchParams] = useListSearchParams();
  const urlId = searchParams.get('notification') || null;
  // The router applies a URL change inside a transition, so for a moment the
  // URL is ahead of what renders. The latest choice is held here until the
  // URL catches up, so a fast j-j-k steps from where the user really is.
  const [pending, setPending] = useState<{ id: string | null } | null>(null);
  const selectedId = pending ? pending.id : urlId;
  const [isSplitViewport, setIsSplitViewport] = useState(matchesSplit);
  // Every id written since the choice was made. The URL write is refused when
  // history has already moved on (Back, another route); a location this hook
  // did not write means that happened, and the URL wins again.
  const { key: locationKey } = useLocation();
  const writtenRef = useRef(new Set<string | null>());
  const locationKeyRef = useRef(locationKey);

  useEffect(() => {
    const navigated = locationKeyRef.current !== locationKey;
    locationKeyRef.current = locationKey;
    if (!pending) return;
    if (pending.id === urlId || (navigated && !writtenRef.current.has(urlId))) {
      writtenRef.current.clear();
      setPending(null);
    }
  }, [pending, urlId, locationKey]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(INBOX_SPLIT_QUERY);
    const update = () => setIsSplitViewport(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const select = useCallback((notificationId: string | null) => {
    writtenRef.current.add(notificationId);
    setPending({ id: notificationId });
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      if (notificationId) next.set('notification', notificationId);
      else next.delete('notification');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  return { selectedId, select, isSplitViewport };
}

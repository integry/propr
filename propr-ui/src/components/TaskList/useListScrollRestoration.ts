import { useCallback, useLayoutEffect, useRef, type UIEvent } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/** How far each history entry's list was scrolled, for Back to return to it. */
const scrollPositions = new Map<string, number>();
/** A long session should not keep every entry it ever visited. */
const MAX_REMEMBERED_ENTRIES = 50;

function remember(key: string, top: number): void {
  scrollPositions.delete(key);
  scrollPositions.set(key, top);
  if (scrollPositions.size > MAX_REMEMBERED_ENTRIES) {
    const oldest = scrollPositions.keys().next().value;
    if (oldest !== undefined) scrollPositions.delete(oldest);
  }
}

/**
 * Keeps a list's scroll position per history entry. Leaving the entry (a new
 * page, a filter, or a task opened on its own page) records where the list
 * was; coming back to it with Back or Forward scrolls a freshly mounted list
 * there once its rows are on screen. A list that stays mounted keeps its own
 * position, so closing the side pane never moves it.
 *
 * Returns the props for the scroll container.
 */
export function useListScrollRestoration(ready: boolean) {
  const { key } = useLocation();
  const navigationType = useNavigationType();
  const elementRef = useRef<HTMLDivElement | null>(null);
  const restoredElementRef = useRef<HTMLDivElement | null>(null);
  // The latest position, read from scroll events: when the entry changes the
  // container may already be gone, and a detached element reads as 0.
  const lastTopRef = useRef(0);

  useLayoutEffect(() => () => remember(key, lastTopRef.current), [key]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!ready || !element || restoredElementRef.current === element) return;
    restoredElementRef.current = element;
    const saved = scrollPositions.get(key);
    if (navigationType === 'POP' && saved !== undefined) element.scrollTop = saved;
    lastTopRef.current = element.scrollTop;
  }, [key, navigationType, ready]);

  const ref = useCallback((element: HTMLDivElement | null) => { elementRef.current = element; }, []);
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    lastTopRef.current = event.currentTarget.scrollTop;
  }, []);
  return { ref, onScroll };
}

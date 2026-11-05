import { useCallback, useEffect, useRef } from 'react';
import { currentUiPathname } from '../config/runtimeMode';

interface HistoryEntry { key: unknown; idx: unknown; pathname: string }

// The browser's current entry, not the router's: after Back the router may keep rendering the previous
// page inside a transition (lazy route chunk), but window history has already moved.
const currentHistoryEntry = (): HistoryEntry => {
  const state = window.history.state as { key?: unknown; idx?: unknown } | null;
  return { key: state?.key, idx: state?.idx, pathname: currentUiPathname() };
};

/**
 * Lets async work started on one history entry tell whether the user is still on it when it completes.
 * claim() records the current entry; the returned check fails after unmount, back/forward or any
 * navigation. replaceUiPathInPlace keeps the router's entry key and index, so the in-place
 * /studio/new → /studio/:id swap stays owned when its path is passed as allowedPathname.
 */
export function useHistoryEntryOwnership() {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  return useCallback(() => {
    const claimed = currentHistoryEntry();
    return (allowedPathname?: string) => {
      if (!mountedRef.current) return false;
      const current = currentHistoryEntry();
      return current.key === claimed.key && current.idx === claimed.idx
        && (current.pathname === claimed.pathname || current.pathname === allowedPathname);
    };
  }, []);
}

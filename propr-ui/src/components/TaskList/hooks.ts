import { useCallback, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { UNSAFE_NavigationContext, createSearchParams, useLocation, useNavigate, useSearchParams, type Location, type Navigator, type SetURLSearchParams } from 'react-router-dom';

/**
 * Task, Plan and Goal filters and selection share this write boundary. React
 * Router's normal functional setter reads render-time params, not the current
 * history entry. History can already have advanced while a transition is still
 * rendering, e.g. while a lazy destination route loads and the departing list
 * stays mounted with its debounced search still pending.
 */
export function useListSearchParams(): ReturnType<typeof useSearchParams> {
  const [params] = useSearchParams();
  const origin = useLocation();
  const navigate = useNavigate();
  // BrowserRouter, HashRouter (desktop), and MemoryRouter expose their history
  // as navigator. Keep this adapter here rather than reading window.location,
  // which would miss hash routing and in-memory navigation.
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const history = navigator as Navigator & { location: Location; action: string };
  const setParams: SetURLSearchParams = useCallback((update, options) => {
    const current = history.location;
    // A queued list edit must never undo a route change or Back/Forward.
    if (current.pathname !== origin.pathname ||
        (current.key !== origin.key && history.action !== 'REPLACE')) return;
    const next = typeof update === 'function'
      ? update(new URLSearchParams(current.search))
      : update;
    navigate({ search: `?${createSearchParams(next).toString()}`, hash: current.hash }, options);
  }, [history, navigate, origin]);
  return [params, setParams];
}

/** Custom hook that debounces a value and calls a callback when it changes */
export function useDebouncedCallback<T>(
  value: T,
  callback: (value: T) => void,
  delay: number,
  retainPendingCallback = false,
): void {
  const previousValue = useRef(value);
  const callbackRef = useRef(callback);
  useLayoutEffect(() => { callbackRef.current = callback; }, [callback]);

  // Tasks retain the edit's navigation origin; other consumers keep the
  // existing behavior of rescheduling when their callback changes.
  const callbackDependency = retainPendingCallback ? null : callback;
  useEffect(() => {
    if (value === previousValue.current) return;

    // Keep the callback belonging to this edit. Unrelated URL renders must not
    // restart its deadline or retarget an old edit after navigation.
    const onChange = callbackRef.current;
    const timer = setTimeout(() => {
      previousValue.current = value;
      onChange(value);
    }, delay);

    return () => clearTimeout(timer);
  }, [value, delay, callbackDependency]);
}

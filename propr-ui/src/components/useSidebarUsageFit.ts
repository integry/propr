import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SIDEBAR_DENSE_ROW_SAVING_PX, SIDEBAR_ROW_ATTRIBUTE } from './SidebarNavigation';

/** Rounding slack, so a sub-pixel difference never flips the layout back and forth. */
const SLACK_PX = 1;

export interface SidebarUsageFit {
  /** Whether the Usage block is folded to its one-line summary to give the navigation room. */
  compact: boolean;
  /** The sidebar column, the navigation scroller and the usage block, for measuring. */
  columnRef: (element: HTMLElement | null) => void;
  navRef: (element: HTMLElement | null) => void;
  bottomRef: (element: HTMLElement | null) => void;
  usageRef: (element: HTMLElement | null) => void;
}

/**
 * Every sidebar item stays on screen: when the navigation does not fit above
 * the Usage block (a 720px or 768px tall window), Usage folds to one line
 * first and the navigation rows tighten. Both return once the column has
 * room for them, so a taller window shows the full block. Whatever still does not fit scrolls, with a visible
 * scrollbar (see SidebarNavigation).
 */
export function useSidebarUsageFit(): SidebarUsageFit {
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(compact);
  const elements = useRef<{ column: HTMLElement | null; nav: HTMLElement | null; bottom: HTMLElement | null; usage: HTMLElement | null }>({
    column: null, nav: null, bottom: null, usage: null,
  });
  // The whole bottom block's height (Usage plus the account and footer gaps that
  // tighten with it), measured while the full layout showed, so the full layout
  // only returns when all of it fits.
  const fullBottomHeight = useRef(0);
  const [observed, setObserved] = useState(0);

  const evaluate = useCallback(() => {
    const { column, nav, bottom, usage } = elements.current;
    if (!column || !nav || !bottom) return;
    const overflowing = nav.scrollHeight > nav.clientHeight + SLACK_PX;
    if (!compactRef.current) {
      if (!usage || !overflowing) return;
      fullBottomHeight.current = bottom.offsetHeight;
      compactRef.current = true;
      setCompact(true);
      return;
    }
    if (overflowing) return;
    const free = column.clientHeight - nav.offsetHeight - bottom.offsetHeight;
    // The bottom block is compared whole, so its margins count as well as Usage,
    // and every navigation row grows back by the same fixed amount; with both
    // budgeted, expanding cannot overflow again.
    const rows = nav.querySelectorAll(`[${SIDEBAR_ROW_ATTRIBUTE}]`).length;
    const growth = fullBottomHeight.current - bottom.offsetHeight + rows * SIDEBAR_DENSE_ROW_SAVING_PX;
    if (free >= growth + SLACK_PX) {
      compactRef.current = false;
      setCompact(false);
    }
  }, []);

  const bind = useCallback((name: keyof typeof elements.current) => (element: HTMLElement | null) => {
    if (elements.current[name] === element) return;
    elements.current[name] = element;
    setObserved(count => count + 1);
  }, []);
  const refs = useMemo(() => ({
    columnRef: bind('column'), navRef: bind('nav'), bottomRef: bind('bottom'), usageRef: bind('usage'),
  }), [bind]);

  useLayoutEffect(() => {
    evaluate();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => evaluate());
    const { column, nav, bottom, usage } = elements.current;
    for (const element of [column, bottom, usage, nav]) if (element) observer.observe(element);
    // The navigation's own size is clipped; its contents grow when a group opens.
    for (const child of Array.from(nav?.children ?? [])) observer.observe(child);
    return () => observer.disconnect();
  }, [evaluate, observed, compact]);

  return { compact, ...refs };
}

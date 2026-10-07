import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const GAP = 4;
const VIEWPORT_MARGIN = 8;

export interface PopoverPosition {
  top?: number;
  bottom?: number;
  right: number;
  maxHeight: number;
}

/**
 * Places a fixed popover below its trigger, flipping above when the content does not fit
 * below and there is more room above. Whichever side is chosen bounds the height, so the
 * popover scrolls internally instead of running off-screen.
 */
export function computePopoverPosition(
  trigger: Pick<DOMRect, 'top' | 'bottom' | 'right'>,
  contentHeight: number,
  viewport: { width: number; height: number },
): PopoverPosition {
  const right = Math.max(VIEWPORT_MARGIN, viewport.width - trigger.right);
  const spaceBelow = Math.max(0, viewport.height - trigger.bottom - GAP - VIEWPORT_MARGIN);
  const spaceAbove = Math.max(0, trigger.top - GAP - VIEWPORT_MARGIN);
  if (contentHeight <= spaceBelow || spaceBelow >= spaceAbove) {
    return { top: trigger.bottom + GAP, right, maxHeight: spaceBelow };
  }
  return { bottom: viewport.height - trigger.top + GAP, right, maxHeight: spaceAbove };
}

const isSamePosition = (left: PopoverPosition, right: PopoverPosition) =>
  left.top === right.top && left.bottom === right.bottom && left.right === right.right && left.maxHeight === right.maxHeight;

/**
 * Open state, viewport-aware placement and dismissal (outside click, Escape, resize, scroll
 * outside the popover) for a popover portalled with fixed coordinates.
 */
export function useAnchoredPopover<TContainer extends HTMLElement = HTMLDivElement>() {
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const open = position !== null;
  const containerRef = useRef<TContainer>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setPosition(null), []);
  const place = useCallback((contentHeight: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return computePopoverPosition(rect, contentHeight, { width: window.innerWidth, height: window.innerHeight });
  }, []);
  const toggle = useCallback(() => {
    if (open) { close(); return; }
    setPosition(place(0));
  }, [close, open, place]);

  // Once the content has rendered, its natural height decides whether it fits below or flips
  // above; content that grows later (e.g. switching to multi-model) is placed again.
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!open || !popover) return;
    const update = () => {
      const next = place(popover.scrollHeight);
      if (!next) return;
      setPosition(previous => (previous === null || isSamePosition(previous, next) ? previous : next));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    Array.from(popover.children).forEach(child => observer.observe(child));
    return () => observer.disconnect();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !popoverRef.current?.contains(target)) close();
    };
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const handleScroll = (event: Event) => {
      if (!popoverRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', close);
    };
  }, [close, open]);

  return { open, position, toggle, close, containerRef, popoverRef };
}

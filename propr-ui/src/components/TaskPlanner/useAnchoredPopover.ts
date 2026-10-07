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

const isOutsideViewport = (rect: DOMRect) => rect.bottom < 0 || rect.top > window.innerHeight;

export interface AnchoredPopoverOptions {
  /** Moves focus into the popover when it opens (dialogs); menus that focus their own items leave this off. */
  focusOnOpen?: boolean;
}

export interface ClosePopoverOptions {
  /** Returns focus to the trigger, as keyboard dismissal (Escape) expects. */
  restoreFocus?: boolean;
}

/**
 * Open state, viewport-aware placement and dismissal (outside click, Escape, resize) for a
 * popover portalled with fixed coordinates. Scrolling a container that holds the trigger keeps
 * the popover anchored to it, and only closes it once the trigger has scrolled out of view.
 */
export function useAnchoredPopover<TContainer extends HTMLElement = HTMLDivElement>(options: AnchoredPopoverOptions = {}) {
  const { focusOnOpen = false } = options;
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const open = position !== null;
  const containerRef = useRef<TContainer>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const close = useCallback((closeOptions: ClosePopoverOptions = {}) => {
    // Inputs inside commit on blur (e.g. Max Loops). Unmounting a focused input does not fire
    // blur, so release focus first and let the pending edit commit before the popover goes away.
    const active = document.activeElement;
    const focusWasInside = active instanceof HTMLElement && Boolean(popoverRef.current?.contains(active));
    if (focusWasInside) (active as HTMLElement).blur();
    setPosition(null);
    if (closeOptions.restoreFocus && (focusWasInside || active === document.body)) {
      containerRef.current?.querySelector<HTMLElement>('button, [tabindex]')?.focus();
    }
  }, []);
  const place = useCallback((contentHeight: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return computePopoverPosition(rect, contentHeight, { width: window.innerWidth, height: window.innerHeight });
  }, []);
  const toggle = useCallback(() => {
    if (open) { close(); return; }
    setPosition(place(0));
  }, [close, open, place]);

  const reposition = useCallback(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const next = place(popover.scrollHeight);
    if (!next) return;
    setPosition(previous => (previous === null || isSamePosition(previous, next) ? previous : next));
  }, [place]);

  // Once the content has rendered, its natural height decides whether it fits below or flips
  // above; content that grows later (e.g. switching to multi-model) is placed again.
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!open || !popover) return;
    reposition();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reposition);
    Array.from(popover.children).forEach(child => observer.observe(child));
    return () => observer.disconnect();
  }, [open, reposition]);

  useEffect(() => {
    if (!open || !focusOnOpen) return;
    popoverRef.current?.focus({ preventScroll: true });
  }, [focusOnOpen, open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !popoverRef.current?.contains(target)) close();
    };
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close({ restoreFocus: true }); };
    const handleResize = () => close();
    const handleScroll = (event: Event) => {
      const target = event.target as Node;
      const trigger = containerRef.current;
      // Scrolling inside the popover, or in a container that does not hold the trigger
      // (e.g. a programmatic scrollIntoView elsewhere), leaves the anchor where it was.
      if (!trigger || popoverRef.current?.contains(target) || !target.contains?.(trigger)) return;
      if (isOutsideViewport(trigger.getBoundingClientRect())) { close(); return; }
      reposition();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [close, open, reposition]);

  return { open, position, toggle, close, containerRef, popoverRef };
}

import { useEffect } from 'react';

// Both task sheets can own a lock. Only the last owner restores the page.
let owners = 0;
let restore: (() => void) | undefined;

/** Lock the document and explicitly marked task panes while a task sheet is open. */
export function useLockTaskScroll(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    if (owners++ === 0) {
      const body = document.body;
      const x = window.scrollX;
      const y = window.scrollY;
      const properties = ['overflow', 'position', 'top', 'left', 'width'] as const;
      const previous = properties.map(key => [key, body.style.getPropertyValue(key), body.style.getPropertyPriority(key)]);
      // A live CSS selector also covers panes mounted while either sheet owns the lock.
      // Removing our rule restores each pane's current styles without stale node snapshots.
      const paneLock = document.createElement('style');
      paneLock.textContent = '[data-scroll-lock-target] { overflow: hidden !important; }';
      document.head.append(paneLock);
      body.style.overflow = 'hidden';
      // Fixed positioning also locks the document scroller on iOS Safari.
      body.style.position = 'fixed';
      body.style.top = `${-y}px`;
      body.style.left = `${-x}px`;
      body.style.width = '100%';
      restore = () => {
        previous.forEach(([key, value, priority]) => body.style.setProperty(key, value, priority));
        paneLock.remove();
        if (typeof window.scrollTo === 'function' && (window.scrollX !== x || window.scrollY !== y)) {
          window.scrollTo({ left: x, top: y, behavior: 'instant' });
        }
      };
    }
    return () => {
      if (--owners === 0) {
        restore?.();
        restore = undefined;
      }
    };
  }, [open]);
}

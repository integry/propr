import { useEffect, useState } from 'react';

/** The workspace's pinned timeline and files headings, in rem: they grow with the text. */
const PINNED_HEADINGS_REM = 4.5;
/** The least room, in px, left for rows under those headings: about seven file or run rows. */
const MIN_ROWS_PX = 184;
/** The collapsed execution-log bar's height (`h-9`), which always sits below the workspace. */
const LOG_BAR_REM = 2.25;

// A short task (see `useShortWorkspace`) scrolls as one page: the header scrolls away, the workspace takes
// its content's height and the log bar stays pinned below. Scroll padding keeps a revealed or focused row
// clear of the pane heading pinned above it and the log bar (and its border) below. It matches the bar
// exactly: any more and focus returning to a row resting whole just above the bar would scroll the page.
export const SHORT_DETAILS = 'data-[short-workspace]:overflow-y-auto data-[short-workspace]:scroll-pt-[4.5rem] data-[short-workspace]:scroll-pb-[calc(2.25rem+1px)]';
export const SHORT_STATIC = 'group-data-[short-workspace]/task:static';
export const SHORT_UNBOUNDED = 'group-data-[short-workspace]/task:flex-none group-data-[short-workspace]/task:overflow-visible';
export const SHORT_LOG_BAR = 'group-data-[short-workspace]/task:sticky group-data-[short-workspace]/task:bottom-0 group-data-[short-workspace]/task:z-10 group-data-[short-workspace]/task:flex-none';
// An open log keeps its own height rather than sharing the page's (none) left over.
export const SHORT_OPEN_LOG = 'group-data-[short-workspace]/task:h-[clamp(12rem,42dvh,22rem)]';

/**
 * Whether the desktop task header leaves the workspace too short to use: a phone in landscape,
 * a short desktop window, an on-screen keyboard or enlarged text. The task then scrolls as one
 * page, so the header and the pinned bands give way to whatever the reader scrolls to.
 *
 * The decision reads only the space the header leaves, which the switch itself never changes,
 * so it cannot flip back and forth. Pinch zoom is left alone, as it pans rather than resizes.
 */
export function useShortWorkspace() {
  const [details, setDetails] = useState<HTMLElement | null>(null);
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [short, setShort] = useState(false);
  useEffect(() => {
    if (!details || !header || typeof ResizeObserver === 'undefined') return;
    const viewport = window.visualViewport;
    const update = () => {
      // The phone layout hides this header and already scrolls as one page.
      if (!header.offsetHeight) { setShort(false); return; }
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const box = details.getBoundingClientRect();
      const bottom = viewport && Math.abs(viewport.scale - 1) <= 0.01
        ? Math.min(box.top + details.clientHeight, viewport.offsetTop + viewport.height)
        : box.top + details.clientHeight;
      setShort(bottom - box.top - header.offsetHeight - (LOG_BAR_REM + PINNED_HEADINGS_REM) * rem < MIN_ROWS_PX);
    };
    const observer = new ResizeObserver(update);
    for (const target of [details, header]) observer.observe(target);
    viewport?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    update();
    return () => {
      observer.disconnect();
      viewport?.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
    };
  }, [details, header]);
  // The marker every `SHORT_*` class keys on.
  return { detailsProps: { ref: setDetails, 'data-short-workspace': short || undefined }, headerRef: setHeader };
}

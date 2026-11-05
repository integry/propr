import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, type LucideIcon } from 'lucide-react';
import { inertOutside } from '../utils/modalBackground';
import { useVisualViewportFrame } from '../hooks/useVisualViewportFrame';

interface CreationDialogProps {
  title: string;
  icon: LucideIcon;
  description: string;
  closeLabel: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
}

/** Shared creation shell: centered, scrollable, and keyboard accessible. */
export function CreationDialog({ title, icon: Icon, description, closeLabel, onClose, busy, children }: CreationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const layerRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Desktop window controls stay usable; the rest of the app is inert.
    const restoreBackground = paneRef.current ? inertOutside(paneRef.current) : undefined;
    const frame = requestAnimationFrame(() => {
      (paneRef.current?.querySelector<HTMLElement>('textarea:not(:disabled)') ?? paneRef.current)?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== 'Tab' || !paneRef.current) return;
      const focusable = Array.from(paneRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [href], [tabindex]:not([tabindex="-1"])',
      )).filter(element => {
        const closedDetails = element.closest('details:not([open])');
        return !element.classList.contains('hidden') && (!closedDetails || element === closedDetails.querySelector('summary'));
      });
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); paneRef.current.focus(); return; }
      if (!paneRef.current.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === paneRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      restoreBackground?.();
      document.removeEventListener('keydown', handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  useVisualViewportFrame(layerRef);
  useEffect(() => {
    const pane = paneRef.current;
    const header = pane?.querySelector('header');
    if (!pane || !header || typeof ResizeObserver === 'undefined') return;
    // Enlarged text wraps the title and the action labels, so whether a whole action fits below a sticky header is
    // measured, not assumed from one-line contents. Neither height depends on whether the header sticks.
    const measure = () => {
      const actions = Array.from(pane.querySelectorAll<HTMLElement>('[data-creation-actions] > *'));
      const action = Math.max(0, ...actions.map(element => element.getBoundingClientRect().height));
      const headerHeight = header.getBoundingClientRect().height;
      pane.style.setProperty('--creation-header', `${headerHeight}px`);
      pane.dataset.headerFit = pane.clientHeight - headerHeight + 0.5 >= action ? 'sticky' : 'scroll';
      actions.forEach(element => observer.observe(element));
    };
    const observer = new ResizeObserver(measure);
    for (const element of [pane, header, pane.lastElementChild]) if (element) observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  // The pane fits the layer, which starts below the desktop titlebar and
  // follows the visible area while an on-screen keyboard is open. A band too
  // short for the header, editor and actions together (a landscape phone with
  // its keyboard up, or a short or zoomed-in desktop window) scrolls the whole
  // pane under a sticky header, so the close button stays put and every field
  // and action is a scroll away. Under a keyboard that pane spans the layer's
  // padding too, leaving room for a 44px control. A band shorter still cannot
  // show the header and a 44px action together, so there the header scrolls
  // away with the rest and the reader scrolls back up to reach the close
  // button: under 4.8rem inside the padding for the keyboard's 41px header,
  // and under 7.5rem for the bordered pane's 73px header otherwise. Enlarged
  // text wraps both, so wherever the measured header leaves less than the
  // tallest action below it, the header scrolls away too. Taller but narrow
  // panes whose wrapped header and actions still leave the form too little
  // room scroll as a whole too, rather than clipping the actions at the pane's
  // edge.
  return createPortal(<div ref={layerRef} className="app-modal-layer group fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-3 [container-type:size] sm:p-6 data-[visual-viewport=clipped]:p-1"
    onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={paneRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
      className="group/pane flex max-h-full w-full max-w-2xl min-w-0 flex-col overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white shadow-2xl outline-none [@container(max-height:20rem)]:group-data-[visual-viewport=clipped]:max-h-[calc(100%+0.5rem)] [@container(max-height:20rem)]:group-data-[visual-viewport=clipped]:rounded-none [@container(max-height:20rem)]:group-data-[visual-viewport=clipped]:border-y-0 [@container(min-height:7.5rem)_and_(max-height:20rem)]:scroll-pt-[var(--creation-header,calc(4.5rem+1px))] [@container(min-height:4.8rem)_and_(max-height:20rem)]:group-data-[visual-viewport=clipped]:scroll-pt-[max(2.75rem,var(--creation-header,0px))] data-[header-fit=scroll]:!scroll-pt-0">
      <header className="top-0 z-10 flex flex-none items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4 group-data-[visual-viewport=clipped]:py-1 sm:px-7 [@container(min-height:7.5rem)_and_(max-height:20rem)]:sticky [@container(min-height:4.8rem)_and_(max-height:20rem)]:group-data-[visual-viewport=clipped]:sticky [@container(max-height:20rem)]:items-center [@container(max-height:20rem)]:group-data-[visual-viewport=clipped]:py-0 group-data-[header-fit=scroll]/pane:!static">
        <div><h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-slate-900"><Icon aria-hidden="true" className="h-5 w-5 flex-none" />{title}</h2>
          <p id={descriptionId} className="mt-1 text-sm text-slate-500 group-data-[visual-viewport=clipped]:line-clamp-1 [@container(max-height:20rem)]:sr-only">{description}</p></div>
        <button type="button" onClick={onClose} disabled={busy} aria-label={closeLabel} className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"><X className="h-5 w-5" /></button>
      </header>
      <div className="flex min-h-0 flex-col [@container(max-height:20rem)]:flex-none" onInvalidCapture={event => {
        // Invalid advanced fields must be visible before the browser focuses them.
        const details = (event.target as HTMLElement).closest('details');
        if (details) details.open = true;
      }}>{children}</div>
    </div>
  </div>, document.body);
}

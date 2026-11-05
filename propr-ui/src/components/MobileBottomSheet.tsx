import React, { useEffect, useRef } from 'react';
import { ChevronLeft, X } from 'lucide-react';
import { useVisualViewportFrame } from '../hooks/useVisualViewportFrame';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'details > summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface BottomSheetProps {
  id: string;
  title: string;
  /** Decorative mark shown before the title; the title alone names the dialog. */
  titleIcon?: React.ReactNode;
  closeLabel: string;
  /** A control placed in the header just before Close (e.g. the ProPR menu's Search). */
  headerAction?: React.ReactNode;
  onClose: () => void;
  // A drill-down sheet (e.g. More › Usage) offers a way back to its parent.
  onBack?: () => void;
  backLabel?: string;
  children: React.ReactNode;
}

// A modal sheet anchored to the bottom bar: focus moves in and is trapped,
// Escape or the backdrop closes it, and the page behind does not scroll. The
// scrim dims and blurs the page so a white sheet never floats on a white
// dashboard. The bottom padding keeps the last row 20px clear of the
// home-gesture bar. The close button is a 44px touch target; its negative
// margins keep the header the same height, and the sheet's scroll padding
// keeps a row scrolled or tabbed into view from ending up under that sticky
// header. While an on-screen keyboard pans
// the visible area (the expanded New To-do form), the layer follows it and the
// sheet is capped to it, so its header stays in view above the keyboard. A band
// too short for the 61px header and a 44px control below it (a landscape phone,
// under 6.75rem) lets the header scroll away with the form instead, so every
// field and action can be scrolled fully into view; Close is back at the top.
// The keyboard covers the home-gesture bar there, so the form ends at its last row.
const BottomSheet: React.FC<BottomSheetProps> = ({ id, title, titleIcon, closeLabel, headerAction, onClose, onBack, backLabel = 'Back', children }) => {
  const layerRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useVisualViewportFrame(layerRef);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const firstFocusable = sheetRef.current?.querySelector<HTMLElement>(focusableSelector);
    firstFocusable?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !sheetRef.current) return;

      const focusable = Array.from(sheetRef.current.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) {
        event.preventDefault();
        sheetRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={layerRef} className="fixed inset-0 z-50 md:hidden data-[visual-viewport=clipped]:[container-type:size]">
      <div
        data-testid={`${id}-backdrop`}
        className="fixed inset-0 z-40 cursor-default bg-slate-900/40 backdrop-blur-sm animate-fade-in motion-reduce:animate-none"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={sheetRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 z-50 max-h-[min(90vh,44rem,100%)] overflow-y-auto scroll-pt-16 rounded-t-2xl bg-white pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl animate-sheet-up motion-reduce:animate-none [@container(max-height:6.75rem)]:scroll-pt-0 [@container(max-height:6.75rem)]:pb-0"
      >
        <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-slate-200 bg-white px-4 py-3 [@container(max-height:6.75rem)]:static">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="-ml-2 rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              aria-label={backLabel}
            >
              <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
          <h2 id={`${id}-title`} className="flex min-w-0 items-center gap-2 text-base font-semibold text-slate-900">
            {titleIcon}
            <span className="min-w-0 truncate">{title}</span>
          </h2>
          {headerAction && <div className="-my-1 ml-auto flex flex-none items-center">{headerAction}</div>}
          <button
            type="button"
            onClick={onClose}
            className={`-my-1 -mr-1 ${headerAction ? '' : 'ml-auto'} inline-flex h-11 w-11 flex-none items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500`}
            aria-label={closeLabel}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
};

export default BottomSheet;

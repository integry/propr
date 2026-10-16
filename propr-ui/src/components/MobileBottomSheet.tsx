import React, { useEffect, useRef } from 'react';
import { ChevronLeft, X } from 'lucide-react';

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
// margins keep the header the same height.
const BottomSheet: React.FC<BottomSheetProps> = ({ id, title, titleIcon, closeLabel, onClose, onBack, backLabel = 'Back', children }) => {
  const sheetRef = useRef<HTMLDivElement>(null);

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
    <div className="fixed inset-0 z-50 md:hidden">
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
        className="absolute inset-x-0 bottom-0 z-50 max-h-[min(90vh,44rem)] overflow-y-auto rounded-t-2xl bg-white pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl animate-sheet-up motion-reduce:animate-none"
      >
        <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-slate-200 bg-white px-4 py-3">
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
          <button
            type="button"
            onClick={onClose}
            className="-my-1 -mr-1 ml-auto inline-flex h-11 w-11 flex-none items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
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

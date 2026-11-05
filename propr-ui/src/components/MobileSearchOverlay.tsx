import React, { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import GlobalSearch from './GlobalSearch';
import { useVisualViewportFrame } from '../hooks/useVisualViewportFrame';

interface MobileSearchOverlayProps {
  /** Increments on every Search request, so a repeat request refocuses the field. */
  request: number;
  onClose: () => void;
}

const FOCUSABLE = 'input, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Search for layouts where the desktop toolbar is collapsed (a narrow or zoomed
 * window). The toolbar's own field is inside a `display: none` ancestor there,
 * so it cannot take focus; this sheet carries the same GlobalSearch across the
 * top of the viewport instead, rather than forcing the toolbar back on.
 *
 * In the Linux desktop frame the sheet starts below the window-control row
 * (desktop.css), so the native controls never cover Close search or the field.
 *
 * An on-screen keyboard shrinks and pans the visual viewport while the layout
 * viewport keeps its size. The sheet follows the visible area, so the field and
 * Close search stay on screen and the results palette fits above the keyboard.
 *
 * It closes on Escape, the close button, a backdrop press, or a route change
 * (choosing a result), and the header restores focus to where it was.
 */
const MobileSearchOverlay: React.FC<MobileSearchOverlayProps> = ({ request, onClose }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const openedAt = useRef(location);
  useVisualViewportFrame(dialogRef);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request]);

  // Choosing a result navigates; the sheet has done its job then.
  useEffect(() => {
    if (location !== openedAt.current) onClose();
  }, [location, onClose]);

  // A backdrop press restores focus on close; stop the press itself from then
  // moving focus to whatever lies under the pointer.
  const dismissFromBackdrop = (event: React.MouseEvent) => {
    event.preventDefault();
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // GlobalSearch closes its palette on Escape and lets the key bubble here.
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    // Keep Tab inside the modal sheet. The input consumes Tab itself while
    // results are shown (category scopes), so this only runs otherwise.
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (focusable.length === 0) return;
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

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Search"
      data-testid="mobile-search-overlay"
      onKeyDown={handleKeyDown}
      className="mobile-search-overlay fixed inset-0 z-50 md:hidden"
    >
      <div aria-hidden="true" onMouseDown={dismissFromBackdrop} className="absolute inset-0 bg-black/40" />
      <div className="relative flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-2 py-2">
        <div className="min-w-0 flex-1">
          {/* With results shown, the palette's own backdrop covers ours; a press
              there must close the whole sheet, not just the palette. */}
          <GlobalSearch inputRef={inputRef} onBackdropDismiss={dismissFromBackdrop} />
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="flex h-11 w-11 flex-none items-center justify-center rounded text-slate-500 hover:bg-slate-200 hover:text-slate-700"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

export default MobileSearchOverlay;

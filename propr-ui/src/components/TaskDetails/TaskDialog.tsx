import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { inertOutside } from '../../utils/modalBackground';
import { useLockTaskScroll } from './useLockTaskScroll';
import { useVisualViewportFrame } from '../../hooks/useVisualViewportFrame';

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

interface TaskDialogProps {
  title: string;
  /** Names what the Close button dismisses, e.g. "Close log files". */
  closeLabel: string;
  onClose: () => void;
  /** Size caps of the dialog on wider screens, as Tailwind classes. */
  sizeClass: string;
  testId?: string;
  children: React.ReactNode;
}

/**
 * The shell of the task's Prompt and Logs viewers: a named modal dialog that
 * fills a phone screen and caps its size on wider ones. Escape and the 44px
 * Close button dismiss it; Tab stays inside, the workspace behind it is inert,
 * and on close focus returns to whatever opened it.
 *
 * While an on-screen keyboard clips the layer it drops its padding and becomes
 * a size container. A band too short for the header and a usable body (under
 * 10rem, a landscape phone with its keyboard up) scrolls the whole pane
 * instead: the header scrolls away and each part takes its natural height, so
 * every control and the content can be scrolled into view.
 */
const TaskDialog: React.FC<TaskDialogProps> = ({ title, closeLabel, onClose, sizeClass, testId, children }) => {
  const titleId = useId();
  const layerRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLockTaskScroll(true);
  // Typing in the log search opens a keyboard that pans the visible area; the layer follows it.
  useVisualViewportFrame(layerRef);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Desktop window controls stay usable; the rest of the app is inert.
    const restoreBackground = paneRef.current ? inertOutside(paneRef.current) : undefined;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !paneRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(paneRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); paneRef.current.focus(); return; }
      if (!paneRef.current.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === paneRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      restoreBackground?.();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <div ref={layerRef} className="app-modal-layer group fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 p-0 sm:items-center sm:p-4 data-[visual-viewport=clipped]:p-0 data-[visual-viewport=clipped]:[container-type:size]">
      <div
        ref={paneRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        className={`flex h-full w-full min-w-0 flex-col overflow-hidden border-gray-300 bg-white shadow-lg outline-none sm:max-h-[min(85vh,100%)] sm:rounded-lg sm:border ${sizeClass} [@container(max-height:10rem)]:overflow-y-auto [@container(max-height:10rem)]:overscroll-contain [@container(max-height:10rem)]:[&>*]:flex-none`}
      >
        <div className="flex flex-none items-center justify-between gap-2 border-b border-gray-200 py-1 pl-4 pr-1 sm:py-2 sm:pr-2">
          <h2 id={titleId} className="min-w-0 break-words text-lg font-semibold text-gray-900">{title}</h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="inline-flex min-h-11 min-w-11 flex-none items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
};

export default TaskDialog;

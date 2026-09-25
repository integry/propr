import React, { useEffect, useId, useRef, useState } from 'react';

interface InboxClearAllButtonProps {
  onConfirm: () => void;
  disabled: boolean;
}

/**
 * Labelled "Clear all" ghost button. Clearing dismisses every notification,
 * including pages not loaded yet, so it asks for confirmation in a popover
 * anchored to the button before doing anything.
 */
export const InboxClearAllButton: React.FC<InboxClearAllButtonProps> = ({ onConfirm, disabled }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return undefined;
    cancelRef.current?.focus();
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const confirm = () => {
    setOpen(false);
    onConfirm();
  };

  return (
    <div ref={containerRef} className="relative flex-none">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(value => !value)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-8 items-center rounded-md px-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-wait disabled:opacity-60"
      >
        Clear all
      </button>
      {open && (
        <div
          role="dialog"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="absolute right-0 top-full z-30 mt-1 w-72 rounded-md border border-slate-200 bg-white p-3 text-left shadow-lg"
        >
          <p id={titleId} className="text-sm font-semibold text-slate-900">Clear all notifications?</p>
          <p id={descriptionId} className="mt-1 text-xs leading-5 text-slate-500">
            Every notification in your Inbox is dismissed, including ones not loaded yet. This can’t be undone.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={close}
              className="inline-flex h-8 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              className="inline-flex h-8 items-center rounded-md bg-red-600 px-3 text-sm font-semibold text-white hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-1"
            >
              Clear Inbox
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default InboxClearAllButton;

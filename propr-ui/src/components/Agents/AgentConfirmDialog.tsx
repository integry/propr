import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';

interface AgentConfirmDialogProps {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  /** Label of the button that closes the dialog without acting. */
  cancelLabel?: string;
  /** Red for destructive or irreversible choices, teal otherwise. */
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const TONE_CLASSES = {
  primary: 'bg-teal-600 hover:bg-teal-700 focus-visible:ring-teal-500',
  danger: 'bg-red-600 hover:bg-red-700 focus-visible:ring-red-500',
} as const;

/**
 * A centered confirmation for run actions; Escape cancels. While open it takes
 * focus, keeps Tab inside it and makes the page behind it inert, then hands
 * focus back to whatever opened it.
 */
export const AgentConfirmDialog: React.FC<AgentConfirmDialogProps> = ({
  title, children, confirmLabel, cancelLabel = 'Cancel', tone = 'primary', busy = false, onConfirm, onCancel,
}) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  useEffect(() => {
    cancelRef.current = onCancel;
    busyRef.current = busy;
  }, [busy, onCancel]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = Array.from(document.body.children).filter(element => !element.contains(dialogRef.current)) as HTMLElement[];
    const previousInert = background.map(element => element.inert);
    background.forEach(element => { element.inert = true; });
    (dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)') ?? dialogRef.current)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) cancelRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
      const active = document.activeElement;
      if (!dialog.contains(active)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && (active === first || active === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      background.forEach((element, index) => { element.inert = previousInert[index]; });
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="w-full max-w-md rounded-lg border border-slate-200 bg-white shadow-2xl outline-none">
        <div className="px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">{title}</h2>
          <div className="mt-2 text-sm text-slate-600">{children}</div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-white focus:outline-none focus-visible:ring-2 disabled:opacity-60 ${TONE_CLASSES[tone]}`}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default AgentConfirmDialog;

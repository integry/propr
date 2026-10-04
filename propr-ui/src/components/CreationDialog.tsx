import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, type LucideIcon } from 'lucide-react';

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
  const paneRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const background = Array.from(document.body.children).filter(element => !element.contains(paneRef.current)) as HTMLElement[];
    const previousInert = background.map(element => element.inert);
    background.forEach(element => { element.inert = true; });
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
      background.forEach((element, index) => { element.inert = previousInert[index]; });
      document.removeEventListener('keydown', handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-3 sm:p-6"
    onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={paneRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
      className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl outline-none sm:max-h-[calc(100dvh-3rem)]">
      <header className="flex flex-none items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-7">
        <div><h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-slate-900"><Icon aria-hidden="true" className="h-5 w-5 flex-none" />{title}</h2>
          <p id={descriptionId} className="mt-1 text-sm text-slate-500">{description}</p></div>
        <button type="button" onClick={onClose} disabled={busy} aria-label={closeLabel} className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"><X className="h-5 w-5" /></button>
      </header>
      <div className="flex min-h-0 flex-col" onInvalidCapture={event => {
        // Invalid advanced fields must be visible before the browser focuses them.
        const details = (event.target as HTMLElement).closest('details');
        if (details) details.open = true;
      }}>{children}</div>
    </div>
  </div>, document.body);
}

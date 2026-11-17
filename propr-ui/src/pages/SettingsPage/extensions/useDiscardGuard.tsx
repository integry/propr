import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { AgentConfirmDialog } from '../../../components/Agents/AgentConfirmDialog';

/** Controls outside a form whose click leaves it: links, Settings category tabs and the phone back button. */
const LEAVING = 'a[href], [role="tab"], [data-settings-mobile-header] button';

/**
 * Keeps typed content of an open editor from being lost unnoticed. Escape and
 * Cancel close the form, asking first when it is `dirty`; so do in-app links
 * and Settings navigation clicked outside the form, which are replayed once
 * the discard is confirmed and the form closed. Reloading or closing the tab gets the browser's
 * own prompt.
 */
export function useDiscardGuard(formRef: RefObject<HTMLElement | null>, dirty: boolean, onClose: () => void): {
  requestClose: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  dialog: ReactNode;
} {
  /** What confirming the discard does: close the form, or replay the click that would leave it. */
  const [pending, setPending] = useState<(() => void) | null>(null);
  const bypass = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const requestClose = useCallback(() => {
    if (dirty) setPending(() => onClose); else onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const click = (event: MouseEvent) => {
      if (bypass.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(LEAVING) : null;
      if (!target || formRef.current?.contains(target) || target.closest('[role="dialog"]')) return;
      if (target instanceof HTMLAnchorElement && (target.target === '_blank' || target.hasAttribute('download'))) return;
      event.preventDefault(); event.stopPropagation();
      setPending(() => () => {
        // Discarding closes this form before the click is replayed. Another open form with typed content then
        // asks for itself, and once it is confirmed this form is gone and cannot intercept that replay.
        closeRef.current();
        bypass.current = true;
        try { target.click(); } finally { bypass.current = false; }
      });
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', click, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', click, true); };
  }, [dirty, formRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Keys pressed in the confirmation dialog bubble here through the portal; it handles them itself.
    if (event.key !== 'Escape' || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
    // The confirmation dialog listens for Escape on the document once it mounts, which can happen while this
    // keypress is still bubbling; stopping it here keeps that listener from cancelling the dialog at once.
    event.preventDefault(); event.stopPropagation();
    requestClose();
  };

  const dialog = pending ? (
    <AgentConfirmDialog title="Discard changes?" confirmLabel="Discard" cancelLabel="Keep editing" tone="danger"
      onCancel={() => setPending(null)} onConfirm={() => { const action = pending; setPending(null); action(); }}>
      What you typed in this form is not saved yet.
    </AgentConfirmDialog>
  ) : null;
  return { requestClose, onKeyDown, dialog };
}

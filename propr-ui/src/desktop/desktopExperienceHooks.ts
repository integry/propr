import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export const useSerializedMutationQueue = () => {
  const queue = useRef<Promise<void>>(Promise.resolve());
  return useCallback((mutation: () => Promise<void>): Promise<void> => {
    const queued = queue.current.then(mutation, mutation);
    queue.current = queued.catch(() => undefined);
    return queued;
  }, []);
};

export const useAttemptFence = (): {
  begin(): () => boolean;
  invalidate(): void;
} => {
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current += 1; }, []);
  const begin = useCallback(() => {
    const attempt = ++generation.current;
    return () => generation.current === attempt;
  }, []);
  useEffect(() => invalidate, [invalidate]);
  return { begin, invalidate };
};

export const useDesktopModal = (
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
  onClose: () => void
): { dialogRef: RefObject<HTMLElement | null>; openModal: () => void } => {
  const dialogRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const openModal = useCallback(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const opener = openerRef.current;
    const focusableElements = () => dialog
      ? [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
      : [];
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusableElements();
      if (!elements.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    (focusableElements()[0] || dialog)?.focus();
    document.addEventListener('keydown', handleKeyboard);
    return () => {
      document.removeEventListener('keydown', handleKeyboard);
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose, open]);

  return { dialogRef, openModal };
};

import { useCallback, useState } from 'react';
import { DiscardChangesDialog, type DiscardQuestion } from './DiscardChangesDialog';

/**
 * `confirmDiscard(question, action)` runs `action` once the user agrees to
 * lose their input; render `dialog` wherever the form is. Only one question
 * is open at a time; asking again replaces it.
 */
export function useDiscardConfirmation() {
  const [pending, setPending] = useState<(DiscardQuestion & { action: () => void }) | null>(null);
  const confirmDiscard = useCallback((question: DiscardQuestion, action: () => void) => {
    setPending({ ...question, action });
  }, []);
  const dialog = pending && (
    <DiscardChangesDialog
      title={pending.title}
      message={pending.message}
      confirmLabel={pending.confirmLabel}
      onCancel={() => setPending(null)}
      onConfirm={() => {
        setPending(null);
        pending.action();
      }}
    />
  );
  return { confirmDiscard, dialog, asking: pending !== null };
}

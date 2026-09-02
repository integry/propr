import React, { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Loader2 } from 'lucide-react';

interface PlanIntentConfirmationDialogProps {
  isOpen: boolean;
  mode: 'approve' | 'execute';
  repository: string;
  issueCount: number;
  agentModelSelection: string;
  prBehavior: string;
  isLoading?: boolean;
  confirmDisabled?: boolean;
  readOnly?: boolean;
  unavailableReason?: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export const PlanIntentConfirmationDialog: React.FC<PlanIntentConfirmationDialogProps> = ({
  isOpen,
  mode,
  repository,
  issueCount,
  agentModelSelection,
  prBehavior,
  isLoading = false,
  confirmDisabled = false,
  readOnly = false,
  unavailableReason,
  onClose,
  onConfirm,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isLoading) onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isLoading, isOpen, onClose]);

  const approving = mode === 'approve';
  const title = approving ? 'Approve this plan?' : 'Start agent work?';
  const description = approving
    ? 'This creates the planned GitHub issues. It does not start an agent; agent and model selection happens in the Execution stage.'
    : 'This starts implementation for the next eligible issue using the current Planner Studio settings.';

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="mobile-plan-intent-overlay fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 md:items-center md:p-4"
          onClick={event => { if (event.target === event.currentTarget && !isLoading) onClose(); }}
        >
          <motion.div
            ref={dialogRef}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            className="max-h-full w-full max-w-lg overflow-y-auto rounded-lg border border-gray-300 bg-white shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plan-intent-confirmation-title"
            tabIndex={-1}
          >
            <div className="p-4 sm:p-6">
              <div className="flex items-start gap-4">
                <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-amber-100">
                  <AlertTriangle className="h-5 w-5 text-amber-600" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 id="plan-intent-confirmation-title" className="text-lg font-semibold text-gray-950">{title}</h2>
                  <p className="mt-2 text-sm leading-5 text-gray-600">{description}</p>
                </div>
              </div>

              <dl className="mt-5 divide-y divide-gray-200 rounded-lg border border-gray-200 bg-gray-50 px-4 text-sm">
                <div className="grid grid-cols-[8rem_1fr] gap-3 py-3">
                  <dt className="font-medium text-gray-500">Repository</dt>
                  <dd className="break-words font-medium text-gray-900">{repository || 'Unavailable'}</dd>
                </div>
                <div className="grid grid-cols-[8rem_1fr] gap-3 py-3">
                  <dt className="font-medium text-gray-500">Issue count</dt>
                  <dd className="text-gray-900">{issueCount}</dd>
                </div>
                <div className="grid grid-cols-[8rem_1fr] gap-3 py-3">
                  <dt className="font-medium text-gray-500">Agent / model</dt>
                  <dd className="break-words text-gray-900">{agentModelSelection}</dd>
                </div>
                <div className="grid grid-cols-[8rem_1fr] gap-3 py-3">
                  <dt className="font-medium text-gray-500">PR behavior</dt>
                  <dd className="text-gray-900">{prBehavior}</dd>
                </div>
              </dl>

              {readOnly && (
                <p role="status" className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  Demo mode is read-only. GitHub issue creation and agent work are disabled.
                </p>
              )}
              {!readOnly && unavailableReason && (
                <p role="status" className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {unavailableReason}
                </p>
              )}
            </div>
            <div className="sticky bottom-0 flex flex-wrap justify-end gap-3 rounded-b-lg border-t border-gray-200 bg-gray-50 px-4 py-3 sm:px-6 sm:py-4">
              <button
                type="button"
                onClick={onClose}
                disabled={isLoading}
                className="rounded-md px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={confirmDisabled || isLoading || readOnly}
                className="inline-flex items-center gap-2 rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {isLoading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {isLoading ? 'Working…' : approving ? 'Approve & Create Issues' : 'Start Agent Work'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default PlanIntentConfirmationDialog;

import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';

interface SequentialWarningDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onProceed: () => void;
}

export const SequentialWarningDialog: React.FC<SequentialWarningDialogProps> = ({
  isOpen,
  onClose,
  onProceed
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Keyboard handling for dialog
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    // Prevent body scroll when dialog is open
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);

    // Focus the dialog for accessibility
    dialogRef.current?.focus();

    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={(e) => {
            // Close on backdrop click
            if (e.target === e.currentTarget) {
              onClose();
            }
          }}
        >
          <motion.div
            ref={dialogRef}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="bg-white rounded-lg max-w-md w-full border border-gray-300 shadow-lg"
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="warning-dialog-title"
          >
            <div className="p-6">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-amber-600" />
                </div>
                <div className="flex-1">
                  <h3 id="warning-dialog-title" className="text-lg font-semibold text-gray-900 mb-2">
                    Previous Tasks Not Merged
                  </h3>
                  <p className="text-sm text-gray-600 mb-4">
                    This task should ideally be implemented after the previous tasks have been merged.
                    Implementing out of order may lead to conflicts or incomplete implementations.
                  </p>
                  <p className="text-sm text-gray-600">
                    Are you sure you want to proceed?
                  </p>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onProceed}
                className="px-4 py-2 text-sm font-medium text-white bg-amber-600 rounded-md hover:bg-amber-700 transition-colors"
              >
                Proceed Anyway
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default SequentialWarningDialog;
